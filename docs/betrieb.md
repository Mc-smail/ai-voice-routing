# Betrieb des Webhooks

## Zugriff einrichten

Der importierte Workflow startet inaktiv. Der Webhook verwendet im Export **Authentication → None**. Für den Zugriff von außerhalb deiner Testumgebung wähle im **Webhook**-Knoten **Header Auth**. Lege dort ein Credential mit dem Headernamen `X-Voice-Token` und einem geheimen Wert an. Hinterlege denselben Wert beim aufrufenden Dienst. Verwende HTTPS und die in n8n angezeigte Produktions-URL des veröffentlichten Workflows. [Webhook-Zugangsdaten in n8n](https://docs.n8n.io/integrations/builtin/credentials/webhook/)

Sende eine synthetische Anfrage. Die beiden Variablen stehen für deine URL und deinen Headerwert.

```bash
curl --request POST "${VOICE_WEBHOOK_URL}" \
  --header "X-Voice-Token: ${VOICE_WEBHOOK_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data '{"transcript":"Mein Router funktioniert nicht."}'
```

Für den Modellknoten legst du ein separates OpenAI-Credential in n8n an. Bewahre beide Zugangsdaten in der Credential-Verwaltung auf.

## Daten und Kosten

- **Datenfluss.** n8n prüft das Transkript und die Berliner Geschäftszeit. Für gültige Anfragen während der Öffnungszeiten sendet der Modellknoten das Transkript und die festen Einordnungsregeln an die OpenAI Responses API. Der Webhook gibt die Abteilung, den Teamnamen, das logische Ziel und eine Meldung zurück.
- **n8n-Speicherung.** Der Workflow-Export setzt `saveDataSuccessExecution` und `saveDataErrorExecution` auf `none` und `saveManualExecutions` auf `false`. Diese Einstellungen gelten für Ausführungsdaten in n8n. Prüfe die Einstellungen deiner Instanz sowie ihre Protokolle, vorgeschalteten Dienste und Backups separat.
- **Speicherung beim Anbieter.** Der OpenAI-Knoten verwendet die Voreinstellung für `Store`. In n8n 2.43.5 ist sie aktiv. Mit **Options → Store** kannst du das Speichern der Antwort für den späteren API-Abruf abschalten. Weitere Aufbewahrungsregeln hängen vom OpenAI-Projekt und der API-Funktion ab. [n8n-Implementierung](https://raw.githubusercontent.com/n8n-io/n8n/n8n%402.43.5/packages/%40n8n/nodes-langchain/nodes/vendors/OpenAi/v2/actions/text/helpers/responses.ts) · [OpenAI-Dateneinstellungen](https://developers.openai.com/api/docs/guides/your-data)
- **API-Kosten.** Die Kosten des KI-Zweigs richten sich nach Modell und Anzahl der Ein- und Ausgabetokens. Der Export verwendet `gpt-4o-mini`. Geschlossene Zeiten und ungültige Eingaben enden vor dem Modellaufruf. Für Beispiele ohne API-Kosten steht `npm run demo` bereit. [OpenAI-API-Preise](https://developers.openai.com/api/docs/pricing)

## Grenzen des Workflows

Die Öffnungszeiten sind Montag bis Freitag von 09:00 bis vor 18:00 Uhr in `Europe/Berlin`. Sie folgen der Sommerzeit. Feiertage folgen dem regulären Wochentag. Das Transkript darf bis zu 8000 UTF-16-Codeeinheiten umfassen.

Der Fehlerzweig sendet HTTP 502 für Fehler, die der Modellknoten an seinen Fehlerausgang meldet. Bei einem Abbruch im Proxy oder beim Aufrufer entscheidet die jeweilige Verbindung über den Status. Die erwarteten JSON-Antworten stehen in der [Webhook-Schnittstelle](webhook.openapi.json).

Der Workflow verarbeitet Text. Ein externer Telefoniedienst übernimmt Transkription und Anrufsteuerung und ordnet `transfer_target` einem tatsächlichen Ziel zu.
