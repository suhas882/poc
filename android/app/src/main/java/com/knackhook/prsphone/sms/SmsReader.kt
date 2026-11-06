package com.knackhook.prsphone.sms

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.Telephony
import androidx.core.content.ContextCompat

/** One text from the phone's SMS store. [id] is the store's own _id, which only ever grows. */
data class Sms(val id: Long, val date: Long, val address: String, val body: String, val sent: Boolean)

/**
 * Reads the phone's SMS store (Telephony.Sms) through the public content provider, with the READ_SMS permission the
 * user granted. Only received and sent texts are read; drafts, outbox and failed texts are skipped.
 * Not covered by this provider: MMS, RCS chat messages, and texts kept only inside other messaging apps.
 */
class SmsReader(private val context: Context) {

    fun canRead(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED

    fun canReceive(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED

    /** "granted", "partial" (can read history but is not told about new texts) or "denied". */
    fun permissionState(): String = when {
        canRead() && canReceive() -> "granted"
        canRead() -> "partial"
        else -> "denied"
    }

    /** Texts with _id greater than [afterId], oldest first, at most [limit]. */
    fun readAfter(afterId: Long, limit: Int): List<Sms> =
        query("${Telephony.Sms._ID} > ? AND $TYPES", arrayOf(afterId.toString()), limit)

    /** Texts dated after [sinceMillis], oldest first: used for a periodic check that nothing was missed. */
    fun readSince(sinceMillis: Long, limit: Int): List<Sms> =
        query("${Telephony.Sms.DATE} > ? AND $TYPES", arrayOf(sinceMillis.toString()), limit)

    fun countAfter(afterId: Long): Long {
        context.contentResolver.query(
            Telephony.Sms.CONTENT_URI, arrayOf(Telephony.Sms._ID), "${Telephony.Sms._ID} > ? AND $TYPES", arrayOf(afterId.toString()), null
        )?.use { return it.count.toLong() }
        return 0
    }

    private fun query(selection: String, args: Array<String>, limit: Int): List<Sms> {
        val out = ArrayList<Sms>(minOf(limit, 512))
        val projection = arrayOf(Telephony.Sms._ID, Telephony.Sms.DATE, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.TYPE)
        context.contentResolver.query(Telephony.Sms.CONTENT_URI, projection, selection, args, "${Telephony.Sms._ID} ASC")?.use { c ->
            val iId = c.getColumnIndexOrThrow(Telephony.Sms._ID)
            val iDate = c.getColumnIndexOrThrow(Telephony.Sms.DATE)
            val iAddr = c.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
            val iBody = c.getColumnIndexOrThrow(Telephony.Sms.BODY)
            val iType = c.getColumnIndexOrThrow(Telephony.Sms.TYPE)
            while (c.moveToNext() && out.size < limit) {
                val body = c.getString(iBody) ?: continue
                if (body.isBlank()) continue
                out += Sms(
                    id = c.getLong(iId),
                    date = c.getLong(iDate),
                    address = c.getString(iAddr).orEmpty(),
                    body = body,
                    sent = c.getInt(iType) == Telephony.Sms.MESSAGE_TYPE_SENT
                )
            }
        }
        return out
    }

    companion object {
        private val TYPES = "${Telephony.Sms.TYPE} IN (${Telephony.Sms.MESSAGE_TYPE_INBOX}, ${Telephony.Sms.MESSAGE_TYPE_SENT})"
    }
}
