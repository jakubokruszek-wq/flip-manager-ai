package pl.jakubokruszek.flipwatcher.geckopoc

import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.URI
import kotlin.concurrent.thread

/**
 * Serves bundled test pages (assets/fixtures/NAME.html) on 127.0.0.1 only, so
 * GeckoView loads them over real HTTP with any path we need (/groups/ID/,
 * /checkpoint/, /login/). The page is chosen by `?fixture=NAME`; names are
 * restricted to [a-z0-9-]. Used by the instrumented tests and the screen-off
 * test — never by the Facebook session.
 */
class LoopbackFixtureServer(private val redirects: Map<String, String> = emptyMap(), private val pages: Map<String, String> = emptyMap(), private val onRequest: ((String, String?) -> Unit)? = null, private val readAsset: (String) -> String?) : AutoCloseable {
    private val socket = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
    val port: Int get() = socket.localPort

    init {
        thread(name = "gecko-poc-fixtures", isDaemon = true) {
            while (!socket.isClosed) {
                val client = try { socket.accept() } catch (_: SocketException) { break }
                thread(isDaemon = true) { client.use(::serve) }
            }
        }
    }

    fun url(path: String, fixture: String): String = "http://127.0.0.1:$port$path?fixture=$fixture"

    private fun serve(client: Socket) {
        val reader = BufferedReader(InputStreamReader(client.getInputStream(), Charsets.UTF_8))
        val requestLine = reader.readLine() ?: return
        var fixtureUserAgent:String?=null
        while (true) { val line = reader.readLine() ?: break; if (line.isEmpty()) break
            if(onRequest!=null&&line.startsWith("User-Agent:",true))fixtureUserAgent=line.substringAfter(':').trim()
        }
        val target = requestLine.split(" ").getOrNull(1) ?: "/"
        val path = runCatching { URI(target).rawPath }.getOrNull()
        onRequest?.invoke(path.orEmpty(),fixtureUserAgent)
        val redirect = redirects[path]
        if (redirect != null && redirect.startsWith("/") && !redirect.startsWith("//") && !redirect.contains('\r') && !redirect.contains('\n')) {
            client.getOutputStream().apply { write("HTTP/1.1 302 Found\r\nLocation: $redirect\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".toByteArray()); flush() }
            return
        }
        val name = fixtureName(target) ?: pages[path]
        val body = name?.let { readAsset("fixtures/$it.html") }
        val (status, content) = if (body != null) "200 OK" to body else "404 Not Found" to "<!doctype html><title>404</title>"
        val bytes = content.toByteArray(Charsets.UTF_8)
        // A real decoded image avoids browser retries of the old text-as-image fixture.
        val contentType = if (name == "load-image" && body != null) "image/svg+xml" else "text/html"
        val out = client.getOutputStream()
        out.write("HTTP/1.1 $status\r\nContent-Type: $contentType; charset=utf-8\r\nContent-Length: ${bytes.size}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".toByteArray())
        out.write(bytes)
        out.flush()
    }

    override fun close() { runCatching { socket.close() } }

    companion object {
        fun fixtureName(target: String): String? {
            val query = runCatching { URI("http://127.0.0.1$target").rawQuery }.getOrNull() ?: return null
            val value = query.split("&").firstNotNullOfOrNull { part -> part.split("=", limit = 2).takeIf { it[0] == "fixture" }?.getOrNull(1) }
            return value?.takeIf { Regex("^[a-z0-9-]{1,40}$").matches(it) }
        }
    }
}
