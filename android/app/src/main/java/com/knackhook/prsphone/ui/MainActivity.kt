package com.knackhook.prsphone.ui

import android.Manifest
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.collectAsState
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.knackhook.prsphone.data.Api
import com.knackhook.prsphone.data.ApiException
import com.knackhook.prsphone.data.PairLink
import com.knackhook.prsphone.data.SecureStore
import com.knackhook.prsphone.sms.SmsReader
import com.knackhook.prsphone.sync.SyncScheduler
import kotlinx.coroutines.launch
import java.io.IOException
import java.text.DateFormat
import java.util.Date

class MainActivity : ComponentActivity() {
    private var deepLink by mutableStateOf<PairLink?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        deepLink = PairLink.parse(intent?.dataString)
        setContent { MaterialTheme { Surface(Modifier.fillMaxSize()) { App(deepLink) { deepLink = null } } } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        PairLink.parse(intent.dataString)?.let { deepLink = it }
    }
}

/** Re-reads SecureStore whenever it changes, so every screen shows current state. */
@Composable
private fun rememberStoreVersion(store: SecureStore): Int {
    var version by remember { mutableIntStateOf(0) }
    DisposableEffect(store) {
        val l = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> version++ }
        store.addListener(l)
        onDispose { store.removeListener(l) }
    }
    return version
}

@Composable
private fun App(deepLink: PairLink?, onDeepLinkUsed: () -> Unit) {
    val context = LocalContext.current
    val store = remember { SecureStore(context) }
    rememberStoreVersion(store) // recompose on any change
    val reader = remember { SmsReader(context) }
    var permissionVersion by remember { mutableIntStateOf(0) }

    Column(
        Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Text("Records Phone Sync", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        when {
            !store.isPaired -> PairScreen(store, deepLink, onDeepLinkUsed)
            !store.consentGiven || !reader.canRead() -> ConsentScreen(store, reader, permissionVersion) { permissionVersion++ }
            else -> StatusScreen(store, reader)
        }
    }
}

/* ---------------- 1. Pairing ---------------- */

@Composable
private fun PairScreen(store: SecureStore, deepLink: PairLink?, onDeepLinkUsed: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var server by remember(deepLink) { mutableStateOf(deepLink?.server ?: store.server.orEmpty()) }
    var code by remember(deepLink) { mutableStateOf(deepLink?.code.orEmpty()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    if (store.revoked) Card { Text(store.lastError ?: "This phone was disconnected. Pair it again to resume.", Modifier.padding(14.dp)) }

    Text("Pair this phone with the website once. Then your texts sync by themselves.")
    Text(
        "On the website, open Connected Sources → Android phone (companion app) → Connect phone. " +
            "Scan the QR code shown there, or type the website address and the code.",
        style = MaterialTheme.typography.bodyMedium
    )

    OutlinedButton(onClick = {
        error = null
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(context, options).startScan()
            .addOnSuccessListener { b ->
                val link = PairLink.parse(b.rawValue)
                if (link == null) error = "That QR code is not a pairing code from the website."
                else { server = link.server; code = link.code }
            }
            .addOnFailureListener { error = "The scanner is not available on this phone. Type the address and code instead." }
    }, modifier = Modifier.fillMaxWidth()) { Text("Scan QR code") }

    OutlinedTextField(
        value = server, onValueChange = { server = it }, label = { Text("Website address") }, placeholder = { Text("https://your-site.example.org") },
        singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), modifier = Modifier.fillMaxWidth()
    )
    OutlinedTextField(
        value = code, onValueChange = { code = PairLink.formatCode(it) }, label = { Text("Pairing code") }, placeholder = { Text("ABCD-2345") },
        singleLine = true, textStyle = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Monospace, letterSpacing = 3.sp),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, keyboardType = KeyboardType.Ascii), modifier = Modifier.fillMaxWidth()
    )
    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }

    Button(enabled = !busy && code.length == 9 && server.isNotBlank(), modifier = Modifier.fillMaxWidth(), onClick = {
        busy = true; error = null
        scope.launch {
            try {
                val base = Api.normalizeServer(server)
                val r = Api(base).pair(code, "${Build.MANUFACTURER} ${Build.MODEL}".trim(), Build.VERSION.RELEASE ?: "")
                store.savePairing(base, r.token, r.deviceName, r.userName, r.sourceName)
                onDeepLinkUsed()
            } catch (e: IllegalArgumentException) {
                error = e.message
            } catch (e: ApiException) {
                error = e.message
            } catch (e: IOException) {
                error = "Could not reach the website. Check the address and your internet connection."
            } finally {
                busy = false
            }
        }
    }) { if (busy) CircularProgressIndicator(Modifier.height(20.dp)) else Text("Pair") }
}

/* ---------------- 2. Consent and SMS permission ---------------- */

@Composable
private fun ConsentScreen(store: SecureStore, reader: SmsReader, @Suppress("UNUSED_PARAMETER") version: Int, onPermissionResult: () -> Unit) {
    val context = LocalContext.current
    var denied by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        onPermissionResult()
        if (result[Manifest.permission.READ_SMS] == true) {
            store.consentGiven = true
            SyncScheduler.ensureScheduled(context)
            SyncScheduler.syncSoon(context)
        } else denied = true
    }

    Text("Paired with ${store.server?.removePrefix("https://")} as ${store.userName}.", fontWeight = FontWeight.SemiBold)
    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Before you allow SMS access", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Bullet("This app reads the text messages (SMS) stored on this phone: received and sent texts, with their phone number and time.")
            Bullet("It sends them, over an encrypted HTTPS connection, only to ${store.server?.removePrefix("https://")}, into your own private source “${store.sourceName}”.")
            Bullet("First it sends your existing texts, then each new text shortly after it arrives.")
            Bullet("It never sends, changes or deletes texts on this phone, and it does not read contacts, photos, MMS pictures, RCS chats or other apps.")
            Bullet("Only send texts that are yours, or that you are authorized to index. Your organization's records policy applies.")
            Bullet("You can stop at any time here (Disconnect) or on the website, and delete everything that was synced.")
        }
    }
    if (denied) {
        Text("SMS access was not allowed, so nothing can be synced.", color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = {
            context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
        }, modifier = Modifier.fillMaxWidth()) { Text("Open app settings → Permissions → SMS") }
    }
    Button(onClick = { launcher.launch(arrayOf(Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS)) }, modifier = Modifier.fillMaxWidth()) {
        Text(if (reader.canRead()) "Continue" else "I agree, allow SMS access")
    }
    if (reader.canRead() && !store.consentGiven) {
        TextButton(onClick = { store.consentGiven = true; SyncScheduler.ensureScheduled(context); SyncScheduler.syncSoon(context) }) { Text("SMS access is already allowed. Start syncing") }
    }
    DisconnectButtons(store)
}

@Composable
private fun Bullet(text: String) = Row { Text("•  "); Text(text, style = MaterialTheme.typography.bodyMedium) }

/* ---------------- 3. Status ---------------- */

@Composable
private fun StatusScreen(store: SecureStore, reader: SmsReader) {
    val context = LocalContext.current
    val work by remember { WorkManager.getInstance(context).getWorkInfosForUniqueWorkFlow(SyncScheduler.SYNC) }.collectAsState(initial = emptyList())
    val running = work.any { it.state == WorkInfo.State.RUNNING }
    val waiting = work.any { it.state == WorkInfo.State.ENQUEUED && it.runAttemptCount > 0 }
    val fmt = remember { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT) }
    val permission = reader.permissionState()

    val syncState = when {
        permission == "denied" -> "Needs SMS permission"
        running -> if (store.pending > 0) "Syncing (${store.pending} to go)" else "Syncing"
        waiting -> "Waiting to retry"
        store.lastError != null -> "Problem, see below"
        store.lastSyncAt == 0L -> "Waiting for the first sync"
        else -> "Up to date"
    }

    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Connected", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                Text(syncState, fontWeight = FontWeight.SemiBold)
            }
            Info("Website", store.server?.removePrefix("https://").orEmpty())
            Info("Signed in as", store.userName.orEmpty())
            Info("This phone", store.deviceName.orEmpty())
            Info("SMS permission", when (permission) { "granted" -> "Allowed"; "partial" -> "Read allowed, new-text alerts off"; else -> "Not allowed" })
            Info("Texts synced", store.totalSynced.toString())
            Info("Last sync", if (store.lastSyncAt > 0) fmt.format(Date(store.lastSyncAt)) else "Not yet")
        }
    }
    store.lastError?.let { Card { Text("Last error: $it", Modifier.padding(14.dp), color = MaterialTheme.colorScheme.error) } }
    if (permission == "partial") Text("New texts are still picked up within about 15 minutes, but allowing “receive SMS” makes it immediate.", style = MaterialTheme.typography.bodySmall)

    Button(onClick = { SyncScheduler.ensureScheduled(context); SyncScheduler.syncSoon(context) }, enabled = !running, modifier = Modifier.fillMaxWidth()) { Text("Sync now") }
    OutlinedButton(onClick = {
        context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
    }, modifier = Modifier.fillMaxWidth()) { Text("Permission settings") }
    Text(
        "Texts sync in the background, also after a restart. Some phone makers stop background apps to save battery; if syncing stalls, " +
            "set this app's battery use to “Unrestricted” in its settings.",
        style = MaterialTheme.typography.bodySmall
    )
    Spacer(Modifier.height(8.dp))
    DisconnectButtons(store)
}

@Composable
private fun Info(label: String, value: String) = Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
    Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Text(value, fontWeight = FontWeight.Medium)
}

/* ---------------- Disconnect ---------------- */

@Composable
private fun DisconnectButtons(store: SecureStore) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var confirm by remember { mutableStateOf<Boolean?>(null) } // null = closed; true = also delete data
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun forget() {
        SyncScheduler.cancelAll(context)
        store.clear()
    }

    OutlinedButton(onClick = { confirm = false }, modifier = Modifier.fillMaxWidth()) { Text("Disconnect") }
    OutlinedButton(
        onClick = { confirm = true }, modifier = Modifier.fillMaxWidth(),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)
    ) { Text("Disconnect and delete synced texts from the website") }
    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }

    confirm?.let { deleteData ->
        AlertDialog(
            onDismissRequest = { if (!busy) confirm = null },
            title = { Text(if (deleteData) "Disconnect and delete?" else "Disconnect?") },
            text = {
                Text(
                    if (deleteData) "The website deletes every text this phone sent. Texts on this phone are not touched. This cannot be undone."
                    else "This phone stops sending texts. Texts already on the website stay until you delete them there."
                )
            },
            confirmButton = {
                TextButton(enabled = !busy, onClick = {
                    busy = true; error = null
                    scope.launch {
                        val server = store.server; val token = store.token
                        try {
                            if (server != null && token != null && !store.revoked) Api(server, token).disconnect(deleteData)
                            forget()
                        } catch (e: ApiException) {
                            if (e.unauthorized) forget() else error = e.message
                        } catch (e: IOException) {
                            error = "Could not reach the website, so nothing was changed there. Try again when online, or disconnect the phone on the website."
                        } finally {
                            busy = false; confirm = null
                        }
                    }
                }) { Text(if (deleteData) "Delete" else "Disconnect") }
            },
            dismissButton = { TextButton(enabled = !busy, onClick = { confirm = null }) { Text("Cancel") } }
        )
    }
}
