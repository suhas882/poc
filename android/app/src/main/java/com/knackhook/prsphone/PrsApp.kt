package com.knackhook.prsphone

import android.app.Application
import android.util.Log
import androidx.work.Configuration
import com.knackhook.prsphone.data.SecureStore
import com.knackhook.prsphone.sync.SyncScheduler

class PrsApp : Application(), Configuration.Provider {

    // WorkManager logs only errors; its own logs never contain message content either.
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder().setMinimumLoggingLevel(Log.ERROR).build()

    override fun onCreate() {
        super.onCreate()
        val store = SecureStore(this)
        if (store.isPaired && store.consentGiven) SyncScheduler.ensureScheduled(this)
    }
}
