package pl.jakubokruszek.flipwatcher.geckopoc

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Before
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WatcherLinkInstrumentedTest {
    private val context get()=InstrumentationRegistry.getInstrumentation().targetContext
    private val token get()="Z".repeat(43)
    private fun credentials()=WatcherLink.Credentials("12345678-1234-1234-1234-123456789012",token)
    @Before fun before(){WatcherLink.forget(context)}
    @After fun after(){WatcherLink.forget(context)}
    @Test fun tokenIsEncryptedPrivateAndSurvivesNewReadWithoutLeakingToDisplay(){
        WatcherLink.save(context,credentials())
        val bytes=File(context.noBackupFilesDir,"watcher-link-v1.bin").readBytes().toString(Charsets.ISO_8859_1)
        assertFalse(bytes.contains(token));assertFalse(bytes.contains(credentials().deviceId));assertFalse(bytes.contains(WatcherLink.ORIGIN))
        val restored=WatcherLink.load(context)!!;assertEquals(token,restored.token);assertEquals(credentials().deviceId,restored.deviceId)
        assertFalse(restored.toString().contains(token))
        WatcherLink.forget(context);assertNull(WatcherLink.load(context))
    }
    @Test fun authenticatedCorruptionFailsWithoutReplacingOrDeletingTokenFile(){
        WatcherLink.save(context,credentials())
        val file=File(context.noBackupFilesDir,"watcher-link-v1.bin");val bytes=file.readBytes()
        bytes[bytes.lastIndex]=(bytes.last().toInt() xor 1).toByte();file.writeBytes(bytes)
        assertTrue(runCatching{WatcherLink.load(context)}.isFailure);assertTrue(file.exists())
    }
    @Test fun dynamicGroupsAreValidatedOnTheRealAndroidJsonRuntime(){
        val json="""{"version":1,"groups":[{"groupId":"297408205383031","name":"FLIPERZY POLSKA","url":"https://www.facebook.com/groups/297408205383031/"}]}"""
        try{
            val groups=WatcherLink.parseGroups(json);WatcherGroups.setActive(groups)
            PocPolicy.selectGroup("297408205383031")
            assertTrue(WatcherGroups.isActive("297408205383031"))
            assertEquals(PageKind.APPROVED_POST,PocPolicy.classify("https://www.facebook.com/groups/297408205383031/posts/1655103482946823/"))
            assertTrue(runCatching{WatcherLink.parseGroups(json.replace("https://www.facebook.com/groups/","https://evil.test/groups/"))}.isFailure)
        }finally{WatcherGroups.setActive(WatcherGroups.configured);PocPolicy.selectGroup(WatcherGroups.LEGACY_GROUP)}
    }

}
