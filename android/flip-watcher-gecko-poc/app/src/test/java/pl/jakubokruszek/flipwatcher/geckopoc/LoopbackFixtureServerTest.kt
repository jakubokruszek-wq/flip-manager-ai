package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL

class LoopbackFixtureServerTest {
    @Test fun `load image is served as an actual image and missing assets remain HTML`() {
        val svg="<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"/>"
        for(present in listOf(true,false))LoopbackFixtureServer { name -> if(present&&name=="fixtures/load-image.html")svg else null }.use { server ->
            val connection=URL(server.url("/data","load-image")).openConnection(Proxy.NO_PROXY) as HttpURLConnection
            try{
                assertEquals(if(present)200 else 404,connection.responseCode)
                assertEquals(if(present)"image/svg+xml; charset=utf-8" else "text/html; charset=utf-8",connection.contentType)
                if(present)assertEquals(svg,connection.inputStream.bufferedReader().readText())
            }finally{connection.disconnect()}
        }
    }

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
