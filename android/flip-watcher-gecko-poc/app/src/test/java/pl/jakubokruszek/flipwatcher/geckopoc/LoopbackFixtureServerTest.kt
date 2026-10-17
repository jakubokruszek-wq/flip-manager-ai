package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL

class LoopbackFixtureServerTest {
    @Test fun `fixture names are restricted`() {
        assertEquals("feed-basic", LoopbackFixtureServer.fixtureName("/groups/1/?fixture=feed-basic"))
        assertNull(LoopbackFixtureServer.fixtureName("/groups/1/?fixture=../../secrets"))
        assertNull(LoopbackFixtureServer.fixtureName("/groups/1/?fixture=A%2F"))
        assertNull(LoopbackFixtureServer.fixtureName("/groups/1/"))
    }

    @Test fun `serves the named asset on loopback and 404 otherwise`() {
        LoopbackFixtureServer { name -> if (name == "fixtures/demo.html") "<p>demo</p>" else null }.use { server ->
            fun get(url: String): Pair<Int, String> {
                val connection = URL(url).openConnection(Proxy.NO_PROXY) as HttpURLConnection
                val code = connection.responseCode
                val body = (if (code == 200) connection.inputStream else connection.errorStream).bufferedReader().readText()
                return code to body
            }
            val (code, body) = get(server.url("/groups/$FIXTURE_GROUP_ID/", "demo"))
            assertEquals(200, code)
            assertTrue(body.contains("demo"))
            assertEquals(404, get(server.url("/x/", "missing")).first)
            assertTrue(server.url("/a/", "b").startsWith("http://127.0.0.1:"))
        }
    }
}
