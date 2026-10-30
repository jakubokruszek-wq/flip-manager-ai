package pl.jakubokruszek.flipwatcher.geckopoc

/** Snapshot of enabled GROUP sources in Watcher, 2026-10-30. Profiles and disabled sources are excluded.
 * Identities are exact: similar names never establish aliases. */
data class WatcherGroup(val id:String,val name:String) {
    init { require(id.matches(Regex("[A-Za-z0-9_.-]{1,100}"))) }
    val url:String get()="https://www.facebook.com/groups/$id/"
}
object WatcherGroups {
    const val LEGACY_GROUP="lodzsprzedazzakupwynajem"
    val configured=listOf(
        WatcherGroup(LEGACY_GROUP,"Łódź sprzedaż zakup wynajem"),
        WatcherGroup("1253809205540869","FLIPY, FLIPPERZY / INWESTORZY"),
        WatcherGroup("1689328011096404","Kupię/sprzedam mieszkanie w Łodzi"),
        WatcherGroup("1424921570856189","Łódź Nieruchomości — Wynajem / Sprzedaż / Kupno / Zamiana"),
        WatcherGroup("mieszkania.na.sprzedaz.lodz","Mieszkania na sprzedaż Łódź. TYLKO SPRZEDAŻ"),
        WatcherGroup("402796264871862","Nieruchomości Łódź — sprzedam, kupię, wynajmę"),
        WatcherGroup("308185249243000","Bałuty Mieszkańcy"),
        WatcherGroup("441817689512680","Łódź Nieruchomości (kupno, sprzedaż, wynajem)"),
        WatcherGroup("mieszkaniawlodzi","Mieszkania Łódź — Odstępne, Sprzedaż, Wynajem"),
        WatcherGroup("w.lodzkim.dzialka.dom.mieszkanie","Nieruchomości woj. Łódzkie"),
        WatcherGroup("ogloszenia.lodzkie","Ogłoszenia Nieruchomości Łódzkie"),
    )
    fun find(id:String)=configured.singleOrNull{it.id==id}
    /** The old encrypted file is retained byte-for-byte; other groups cannot replace it. */
    fun archiveFile(groupId:String):String {
        require(find(groupId)!=null)
        return if(groupId==LEGACY_GROUP)"saved-search-v1.bin" else "saved-search-$groupId-v1.bin"
    }
}
