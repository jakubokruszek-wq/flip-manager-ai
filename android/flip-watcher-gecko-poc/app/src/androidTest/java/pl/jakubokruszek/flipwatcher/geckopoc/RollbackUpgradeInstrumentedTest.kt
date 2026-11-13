package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** CI installs the test APK against 0.5.104, seeds real encrypted state,
 * then uses adb install -r for this release before running b_verify. */
@RunWith(AndroidJUnit4::class)
class RollbackUpgradeInstrumentedTest {
    private val context:Context=ApplicationProvider.getApplicationContext()
    private val device="12345678-1234-1234-1234-123456789012"
    private val token="x".repeat(40)
    private val proof get()=context.getSharedPreferences("rollback-upgrade-proof-v1",Context.MODE_PRIVATE)
    @Test fun a_seedOn104(){
        assertEquals("0.5.104-gecko-poc",context.packageManager.getPackageInfo(context.packageName,0).versionName)
        WatcherAutomation.configure(context,false)
        WatcherLink.save(context,WatcherLink.Credentials(device,token))
        val group=WatcherGroups.configured.first()
        val bitmap=android.graphics.Bitmap.createBitmap(192,144,android.graphics.Bitmap.Config.ARGB_8888)
        val photo=try{bitmap.eraseColor(android.graphics.Color.YELLOW);ResultArchive.photo("550000000000091",0,false,bitmap)}finally{bitmap.recycle()}
        val row=DesktopRow("550000000000091",group.url+"posts/550000000000091/","DOM",430000.0,"EXPLICIT_TOTAL",42.0,2,"Bałuty",null,null,"SELL_PROPERTY",true,0)
        val saved=SavedResult(System.currentTimeMillis(),listOf(row),emptyList(),listOf(photo))
        WatcherOutbox(context).use{q->
            q.enqueue(device,group,saved)
            q.completeScan("rollback-upgrade/cycle",group.key)
            val item=checkNotNull(q.next(device,Long.MAX_VALUE))
            assertTrue(proof.edit().putString("id",item.id).putString("body",item.body).putString("source",group.key).putLong("beforeCode",context.packageManager.getPackageInfo(context.packageName,0).longVersionCode).commit())
        }
        assertTrue(WatcherAutomation.preferences(context).edit().putString("requested_scan","rollback-upgrade-request").putString("scan_minutes","300,785,1231").commit())
        File(context.filesDir,"rollback-upgrade-proof.bin").writeBytes(byteArrayOf(4,9,7,1,0,2))
    }
    @Test fun b_verifyAfterInPlaceUpdate(){
        val installed=context.packageManager.getPackageInfo(context.packageName,0)
        assertEquals("0.5.105-gecko-poc",installed.versionName)
        assertTrue(installed.longVersionCode>proof.getLong("beforeCode",Long.MAX_VALUE))
        val pairing=checkNotNull(WatcherLink.load(context));assertEquals(device,pairing.deviceId);assertEquals(token,pairing.token)
        WatcherOutbox(context).use{q->
            val item=checkNotNull(q.next(device,Long.MAX_VALUE))
            assertEquals(proof.getString("id",null),item.id);assertEquals(proof.getString("body",null),item.body)
            assertTrue(q.scanned("rollback-upgrade/cycle",checkNotNull(proof.getString("source",null))))
            assertEquals(1,org.json.JSONObject(item.body).getJSONArray("photos").length())
        }
        assertEquals("rollback-upgrade-request",WatcherAutomation.preferences(context).getString("requested_scan",null))
        assertEquals("300,785,1231",WatcherAutomation.preferences(context).getString("scan_minutes",null))
        assertArrayEquals(byteArrayOf(4,9,7,1,0,2),File(context.filesDir,"rollback-upgrade-proof.bin").readBytes())
        // Leave the disposable test device neutral for the remaining test suites.
        WatcherAutomation.preferences(context).edit().remove("requested_scan").remove("scan_minutes").commit()
    }
}
