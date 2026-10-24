package pl.jakubokruszek.flipwatcher.geckopoc
import org.junit.Assert.*
import org.junit.Test
class ResponseReloadGateTest {
 private val url = "https://www.facebook.com/groups/approved/"
 @Test fun inactiveAndUnstartedDeny() { val g=ResponseReloadGate(); assertFalse(g.allowLocation(url)); assertFalse(g.allowOldDisconnect()); g.begin(url); assertFalse(g.allowRequest(url,false,false)); assertFalse(g.allowLocation(url)) }
 @Test fun exactlyOneRequest() { val g=ResponseReloadGate(); g.begin(url); g.willLoad(); assertTrue(g.allowRequest(url,false,false)); assertFalse(g.allowRequest(url,false,false)) }
 @Test fun foreignRedirectAndNewWindowDeny() { val g=ResponseReloadGate(); g.begin(url); g.willLoad(); assertFalse(g.allowRequest(url+"posts/12345",false,false)); assertFalse(g.allowRequest(url,true,false)); assertFalse(g.allowRequest(url,false,true)); assertFalse(g.allowLocation(null)) }
 @Test fun duplicateNativeLocationCallbacksAreAllowed() { val g=ResponseReloadGate(); g.begin(url); g.willLoad(); repeat(2) { assertTrue(g.allowLocation(url)) }; assertFalse(g.allowLocation(url+"?changed=1")) }
 @Test fun onlyOldPortDisconnectAllowed() { val g=ResponseReloadGate(); g.begin(url); g.willLoad(); assertTrue(g.allowOldDisconnect()); assertFalse(g.allowOldDisconnect()) }
 @Test fun newConnectionRevokesOldDisconnectException() { val g=ResponseReloadGate(); g.begin(url); g.willLoad(); g.connected(); assertFalse(g.allowOldDisconnect()) }
 @Test fun cancellationCannotReuseConsent() { val g=ResponseReloadGate(); g.begin(url); g.willLoad(); g.cancel(); assertFalse(g.active); assertFalse(g.allowLocation(url)); assertFalse(g.allowOldDisconnect()); assertFalse(g.allowRequest(url,false,false)) }
}
