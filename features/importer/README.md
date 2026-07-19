# Importer nieruchomości

## Granice odpowiedzialności

```
Client -> POST /api/import -> importProperty() -> rejestr adapterów -> adapter portalu
```

- `ImportedProperty` jest wspólnym, znormalizowanym kontraktem i nie zależy od
  struktury żadnego portalu.
- `importProperty()` wybiera pierwszy adapter, którego `supports(url)` zwraca
  `true`; nie rozpoznaje domen ani nie zna parserów.
- Kod pobierający HTML jest wyłącznie serwerowy. Waliduje przekierowania,
  rozmiar odpowiedzi i status HTTP.
- Adapter Otodom najpierw odczytuje dane JSON osadzone w HTML (`__NEXT_DATA__`,
  a potem JSON-LD). Cheerio jest używany tylko wtedy, gdy nie ma rozpoznawalnego
  payloadu JSON ogłoszenia.

## Dodanie kolejnego portalu

1. Utwórz adapter implementujący `PropertyImporterAdapter`.
2. Ogranicz `supports()` do domeny i ścieżek ofert tego portalu.
3. Dodaj parser JSON-first z fallbackiem Cheerio.
4. Dodaj adapter do `adapters/registry.ts` i rozszerz `ImportSource`.

Mapowanie `ImportedProperty` na model zapisywany w bazie pozostaje osobnym
krokiem — importer nie zapisuje danych i nie zależy od modelu tabeli properties.
