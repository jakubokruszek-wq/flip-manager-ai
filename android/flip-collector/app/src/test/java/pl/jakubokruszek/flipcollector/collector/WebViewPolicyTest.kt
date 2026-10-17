package pl.jakubokruszek.flipcollector.collector

import org.junit.Assert.assertEquals
import org.junit.Test
import pl.jakubokruszek.flipcollector.collector.WebViewPolicy.Decision.ALLOW
import pl.jakubokruszek.flipcollector.collector.WebViewPolicy.Decision.BLOCK

class WebViewPolicyTest {
    @Test
    fun navigationOnlyToFacebookOverHttps() {
        assertEquals(ALLOW, WebViewPolicy.navigation("https://www.facebook.com/groups/123/"))
        assertEquals(ALLOW, WebViewPolicy.navigation("https://m.facebook.com/groups/123"))
        assertEquals(ALLOW, WebViewPolicy.navigation("https://WWW.Facebook.com/x"))
        listOf(
            "http://www.facebook.com/groups/123",
            "https://l.facebook.com/l.php?u=https%3A%2F%2Fevil.example",
            "https://www.facebook.com.evil.example/",
            "https://evil.example/?https://www.facebook.com/",
            "https://user@www.facebook.com/",
            "https://www.facebook.com:8443/",
            "intent://scan#Intent;scheme=zxing;end",
            "file:///sdcard/x.html",
            "javascript:alert(1)",
            "data:text/html,<b>x</b>",
            "about:blank",
            "not a url",
            "",
        ).forEach { assertEquals(it, BLOCK, WebViewPolicy.navigation(it)) }
    }

    @Test
    fun resourcesOnlyFromFacebookAndItsCdns() {
        assertEquals(ALLOW, WebViewPolicy.resource("https://static.xx.fbcdn.net/rsrc.php/v3/abc.js"))
        assertEquals(ALLOW, WebViewPolicy.resource("https://www.facebook.com/api/graphql/"))
        assertEquals(ALLOW, WebViewPolicy.resource("https://connect.facebook.net/sdk.js"))
        assertEquals(BLOCK, WebViewPolicy.resource("https://tracker.example/pixel.js"))
        assertEquals(BLOCK, WebViewPolicy.resource("http://static.xx.fbcdn.net/x.js"))
        assertEquals(BLOCK, WebViewPolicy.resource("https://evilfbcdn.net/x.js"))
    }

    @Test
    fun mediaIsBlockedForDataOnlyScans() {
        assertEquals(BLOCK, WebViewPolicy.resource("https://scontent.xx.fbcdn.net/v/t39/123_n.jpg?stp=dst"))
        assertEquals(BLOCK, WebViewPolicy.resource("https://video.xx.fbcdn.net/v/t42/clip.mp4"))
        assertEquals(ALLOW, WebViewPolicy.resource("https://scontent.xx.fbcdn.net/v/t39/123_n.jpg", blockMedia = false))
    }
}
