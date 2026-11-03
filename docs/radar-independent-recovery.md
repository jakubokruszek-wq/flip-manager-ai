# Niezależne wznowienie Radaru

Przy długim skanie serwerowe przekazanie kolejnej porcji może otrzymać HTTP
508. Wcześniej skonfigurowana była samokontynuacja, ale niezależny timer
`price-radar-watchdog` nie był aktywny. Powstawała przerwa do wznowienia przez
otwartą stronę lub zewnętrzny harmonogram.

Produkcja rejestruje teraz minutowy timer w istniejącym Supabase `pg_cron`.
`pg_net` wywołuje dotychczasowy chroniony endpoint Radaru spoza łańcucha
samowywołań. Endpoint odpowiada 202, a następnie stosuje istniejące reguły:
aktywny skan ma wyłączność przez dzierżawę; po jej wygaśnięciu wznawiany jest
ten sam przebieg i checkpoint. STOP, definitywne zakończenie i wyłączenie
automatyki są nadal respektowane. Timer nie ponawia źródeł oznaczonych jako
zakończone lub zatrzymane przez CAPTCHA/limit żądań w bieżącym przebiegu.

Konfiguracja powstaje wyłącznie na serwerze produkcyjnym po prawidłowo
uwierzytelnionym żądaniu. Istniejący `PRICE_RADAR_CRON_SECRET` jest przesyłany
z runtime do Vault przez RPC dostępne tylko dla `service_role`. RPC nie
zwraca sekretu; definicja zadania zawiera odwołanie do Vault, bez wartości
sekretu. Operacja jest idempotentna, obsługuje rotację i nie zmienia innych
zadań harmonogramu. Nie wymaga nowej usługi ani instalacji Androida.

Kontrola bez odczytywania sekretów:

```sql
select jobname,schedule,active from cron.job
where jobname='price-radar-watchdog';
select status,start_time,end_time from cron.job_run_details
where jobid in (select jobid from cron.job where jobname='price-radar-watchdog')
order by start_time desc limit 5;
```

Wyłączenie tego dodatkowego timera: `select cron.unschedule('price-radar-watchdog');`.
Kolejny poprawnie uwierzytelniony tick lub uruchomienie porcji zarejestruje go
ponownie. Wyłączenie automatycznego skanu w ustawieniach pozostaje sposobem
zatrzymania automatycznego uruchamiania i wznawiania przez harmonogram.
