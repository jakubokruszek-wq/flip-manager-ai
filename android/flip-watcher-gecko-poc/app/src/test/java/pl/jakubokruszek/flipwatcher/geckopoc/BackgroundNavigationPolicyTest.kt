package pl.jakubokruszek.flipwatcher.geckopoc
import org.junit.Test
import org.junit.Assert.*
class BackgroundNavigationPolicyTest {
    @Test fun canonicalHostsKeepExactGroupIdentity() {
        for(host in listOf("facebook.com","www.facebook.com","m.facebook.com"))
            assertNull(BackgroundNavigationPolicy.rejection("https://$host/groups/123/?sorting_setting=CHRONOLOGICAL","123"))
        for(url in listOf("https://evil.test/groups/123/","https://m.facebook.com/groups/124/","https://m.facebook.com:443/groups/123/","https://user@m.facebook.com/groups/123/","https://m.facebook.com/groups/123/#x","http://m.facebook.com/groups/123/"))
            assertEquals("GROUP_CONTEXT_REJECTED",BackgroundNavigationPolicy.rejection(url,"123"))
    }
    @Test fun queryPermissionIsExplicitAndDoesNotWeakenManualTrial() {
        val target="https://www.facebook.com/groups/123/?sorting_setting=CHRONOLOGICAL"
        assertFalse(DesktopTrial(target,{0L},groupId="123").begin(true))
        val trial=DesktopTrial(target,{0L},groupId="123",allowRootQuery=true)
        assertTrue(trial.begin(true));assertTrue(trial.armed())
        assertTrue(trial.request(target,false,false,false))
        assertFalse(trial.request("https://www.facebook.com/groups/124/",true,false,false))
    }
    @Test fun challengesAreDiagnosedAndLoopbackIsBoundToOriginalPort() {
        assertEquals("LOGIN_REQUIRED",BackgroundNavigationPolicy.rejection("https://m.facebook.com/login.php","123"))
        assertEquals("CHECKPOINT",BackgroundNavigationPolicy.rejection("https://www.facebook.com/checkpoint/","123"))
        assertEquals("CAPTCHA",BackgroundNavigationPolicy.rejection("https://www.facebook.com/captcha/","123"))
        assertNull(BackgroundNavigationPolicy.rejection("http://127.0.0.1:8001/groups/123","123","http://127.0.0.1:8001/groups/123/"))
        assertEquals("GROUP_CONTEXT_REJECTED",BackgroundNavigationPolicy.rejection("http://127.0.0.1:8002/groups/123","123","http://127.0.0.1:8001/groups/123/"))
    }
}
