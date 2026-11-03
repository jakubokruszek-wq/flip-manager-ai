package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneId

class ScanStatusTextTest {
    private val now=1_800_000_000_000L
    @Test fun staleProcessIsNotFalselyReportedAsCompletedOrKilledByAndroid(){
        val state=ScanState(phase="READING",heartbeat=now-120_000,changed=now-120_000)
        assertEquals("Brak potwierdzenia dalszej pracy",ScanStatusText.title(state,true,now,false))
        assertEquals("Odczyt postów i zdjęć",ScanStatusText.title(state,true,now,true))
        val text=ScanStatusText.details(state,true,now,now+1000,true,true,"oczekuje",false)
        assertTrue(text.contains("Android nie podał przyczyny"));assertFalse(text.contains("Skan zakończony"))
    }
    @Test fun slowStageShowsHeartbeatSeparatelyFromActualProgress(){
        val state=ScanState(phase="READING",heartbeat=now,changed=now-120_000,total=11,done=3,position=4,group="Grupa testowa",posts=8,photos=5,started=now-130_000)
        val text=ScanStatusText.details(state,true,now,now+1000,true,true,"uruchomione",true,ZoneId.of("Europe/Warsaw"))
        assertTrue(text.contains("Grupy ukończone: 3/11"));assertTrue(text.contains("posty 8 • zdjęcia 5"));assertTrue(text.contains("nie oznacza znalezienia nowych postów"));assertFalse(text.contains("%"))
    }
    @Test fun blockedStartHasSpecificReasonAndNoInventedAndroidDiagnosis(){
        val text=ScanStatusText.details(ScanState(phase="QUEUED"),true,now,now+1000,false,false,"zadanie oczekuje",false)
        assertTrue(text.contains("oczekuje na uruchomienie"));assertTrue(text.contains("oczekuje na dostęp do internetu"));assertTrue(text.contains("Powiadomienia"))
        assertTrue(ScanStatusText.reason("LOGIN_REQUIRED").contains("zaloguj"))
        assertTrue(ScanStatusText.reason("WAITING_FOR_BACKGROUND").contains("ekran główny"))
        assertEquals("Automat wyłączony",ScanStatusText.title(ScanState(phase="DONE"),false,now,false))
    }
}
