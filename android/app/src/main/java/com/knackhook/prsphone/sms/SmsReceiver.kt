package com.knackhook.prsphone.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import com.knackhook.prsphone.data.SecureStore
import com.knackhook.prsphone.sync.SyncScheduler

/**
 * Woken by the system when a text arrives. It does not read the text from the broadcast; it only asks WorkManager
 * to run a sync, which reads the SMS store after the default SMS app has saved the text there.
 */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        if (!SecureStore(context).isPaired) return
        SyncScheduler.syncSoon(context, delaySeconds = 5)
    }
}
