# Cooperative sandbox protocol v2

Selectors: `#shadow-composer`, `#shadow-send`, `#shadow-received`. The extension cancels the user's click/Enter gesture synchronously, scans locally, writes and reads back the approved text, then emits `shadowshield:submit-request` with `{protocol:"v2",attemptId}`. The page appends current text to its in-memory receiver before emitting `shadowshield:receipt` with `{protocol:"v2",attemptId,status:"ACCEPTED"}`. The receipt is page-attested only and never authorizes release. No prompt is sent over network or persisted.
