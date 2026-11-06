package com.knackhook.prsphone.sync

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.knackhook.prsphone.data.Api
import com.knackhook.prsphone.data.ApiException
import com.knackhook.prsphone.data.PhoneStatus
import com.knackhook.prsphone.data.SecureStore
import com.knackhook.prsphone.sms.SmsReader
import java.io.IOException

/**
 * Sends texts the server does not have yet, oldest first, in batches. Incremental by the SMS store's _id: the
 * cursor only moves after the server accepted a batch, so a failure resends that batch next time, and the server
 * ignores anything it already stored. Network and server errors are retried by WorkManager with backoff.
 *
 * Logging: counts and error codes only. Never message bodies, addresses or the key.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val store = SecureStore(applicationContext)
        val server = store.server
        val token = store.token
        if (server == null || token == null || store.revoked) return Result.success()
        val reader = SmsReader(applicationContext)
        val api = Api(server, token)

        if (!reader.canRead()) {
            val msg = "SMS permission is off. Open the app and allow SMS access."
            store.lastError = msg
            runCatching { api.heartbeat(PhoneStatus("denied", lastError = msg)) }
                .onFailure { if (it is ApiException && it.unauthorized) markRevoked(store) }
            return Result.success() // nothing to retry until the user allows access
        }

        return try {
            // First run after pairing or a reinstall: resume where the server is.
            if (store.lastId < 0) store.lastId = api.status().cursor.lastId

            var pending = reader.countAfter(store.lastId)
            store.pending = pending
            var sent = 0
            while (true) {
                val batch = reader.readAfter(store.lastId, BATCH)
                if (batch.isEmpty()) break
                pending = maxOf(0, pending - batch.size)
                setProgress(workDataOf("pending" to pending))
                val r = api.sendMessages(batch, PhoneStatus(reader.permissionState(), pending = pending))
                store.lastId = batch.last().id
                store.totalSynced = r.messages
                store.pending = pending
                store.lastSyncAt = System.currentTimeMillis()
                sent += batch.size
                if (isStopped) return Result.retry()
            }

            // Once a day, resend the last 3 days. The server skips what it has, so this only fills gaps
            // (for example a text the default SMS app saved late with an older _id).
            val now = System.currentTimeMillis()
            if (now - store.lastReconcileAt > DAY) {
                val recent = reader.readSince(now - 3 * DAY, BATCH)
                if (recent.isNotEmpty()) store.totalSynced = api.sendMessages(recent, PhoneStatus(reader.permissionState(), pending = 0)).messages
                store.lastReconcileAt = now
            }

            store.pending = 0
            store.lastSyncAt = now
            store.lastError = null
            api.heartbeat(PhoneStatus(reader.permissionState(), pending = 0, lastError = null))
            Log.i(TAG, "Sync finished: $sent sent")
            Result.success()
        } catch (e: ApiException) {
            when {
                e.unauthorized -> { markRevoked(store); Result.success() }
                e.retryable -> { store.lastError = e.message; Result.retry() }
                else -> { store.lastError = e.message; Log.w(TAG, "Sync refused: ${e.code}"); Result.failure() }
            }
        } catch (e: IOException) {
            store.lastError = "Could not reach the website. Will try again."
            Log.w(TAG, "Network error: ${e.javaClass.simpleName}")
            Result.retry()
        } catch (e: SecurityException) {
            store.lastError = "SMS permission is off. Open the app and allow SMS access."
            Result.success()
        }
    }

    private fun markRevoked(store: SecureStore) {
        store.revoked = true
        store.lastError = "This phone was disconnected on the website. Pair it again to resume."
        SyncScheduler.cancelAll(applicationContext)
    }

    companion object {
        private const val TAG = "PrsSync"
        private const val BATCH = 500
        private const val DAY = 24L * 60 * 60 * 1000
    }
}

/** Runs when the SMS store changes: start a sync and watch for the next change. */
class SmsStoreChangedWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        if (SecureStore(applicationContext).isPaired) {
            SyncScheduler.syncSoon(applicationContext)
            SyncScheduler.armObserver(applicationContext)
        }
        return Result.success()
    }
}
