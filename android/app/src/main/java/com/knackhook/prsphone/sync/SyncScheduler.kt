package com.knackhook.prsphone.sync

import android.content.Context
import android.provider.Telephony
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Three ways a sync starts, all through WorkManager so they survive app restarts and reboots and retry with backoff:
 *  - right away after pairing, after "Sync now", and when a text arrives (SmsReceiver);
 *  - when the SMS store changes (a content-URI trigger), which also catches texts sent from the phone;
 *  - every 15 minutes as a safety net.
 */
object SyncScheduler {
    const val SYNC = "sms-sync"
    private const val PERIODIC = "sms-sync-periodic"
    private const val OBSERVER = "sms-store-observer"

    private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun syncSoon(context: Context, delaySeconds: Long = 0) {
        val req = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(network)
            .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        // APPEND_OR_REPLACE: a text that arrives during a running sync still gets its own run afterwards.
        WorkManager.getInstance(context).enqueueUniqueWork(SYNC, ExistingWorkPolicy.APPEND_OR_REPLACE, req)
    }

    /** Set up the background schedule. Safe to call often. */
    fun ensureScheduled(context: Context) {
        val wm = WorkManager.getInstance(context)
        val periodic = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(network)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        wm.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, periodic)
        armObserver(context, ExistingWorkPolicy.KEEP)
    }

    /** One-shot job that runs when the SMS store changes. It re-arms itself (appended, so it starts after the current run). */
    fun armObserver(context: Context, policy: ExistingWorkPolicy = ExistingWorkPolicy.APPEND_OR_REPLACE) {
        val constraints = Constraints.Builder()
            .addContentUriTrigger(Telephony.Sms.CONTENT_URI, true)
            .setTriggerContentUpdateDelay(5, TimeUnit.SECONDS)
            .setTriggerContentMaxDelay(60, TimeUnit.SECONDS)
            .build()
        val req = OneTimeWorkRequestBuilder<SmsStoreChangedWorker>().setConstraints(constraints).build()
        WorkManager.getInstance(context).enqueueUniqueWork(OBSERVER, policy, req)
    }

    fun cancelAll(context: Context) {
        val wm = WorkManager.getInstance(context)
        wm.cancelUniqueWork(SYNC)
        wm.cancelUniqueWork(PERIODIC)
        wm.cancelUniqueWork(OBSERVER)
    }
}
