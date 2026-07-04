# vuelos-tracker

Trackea precios de vuelos para dos personas y dos configuraciones distintas:

**Pablo — octubre 2026, solo ida, solo Gol**
- Buenos Aires Ezeiza (EZE) - Goiânia (GYN)
- Buenos Aires Ezeiza (EZE) - Brasília (BSB)
- Buenos Aires Aeroparque (AEP) - Goiânia (GYN)
- Buenos Aires Aeroparque (AEP) - Brasília (BSB)

**David — diciembre 2026 / enero-febrero 2027, ida y vuelta, todas las rutas y sitios**
- Buenos Aires (EZE) - Goiânia (GYN)
- Buenos Aires (EZE) - Brasília (BSB)
- Santiago (SCL) - Goiânia (GYN)
- Santiago (SCL) - Brasília (BSB)
- San Luis (LUQ) - Buenos Aires (AEP)

Rutas, persona y tipo de viaje (`oneway`/`roundtrip`) configurables en [`config/routes.json`](config/routes.json). Fechas de búsqueda ida-vuelta (día de salida + noches) en [`config/searchDates.json`](config/searchDates.json) — no aplica a las rutas one-way de Pablo, que registran el precio de cada día del mes (ya viene incluido en la respuesta del calendario de Gol).

## Cómo correr localmente

```
npm install
npx playwright install chromium
npm run scrape
```

Esto actualiza:
- `data/prices.csv`: histórico crudo, una fila por sitio/ruta/fecha/corrida (nunca se sobreescribe, solo se agrega).
- `data/resumen-pablo.csv` y `data/resumen-david.csv`: se regeneran enteros en cada corrida a partir del histórico. Formato pivotado (una fila por ruta+fecha(s), una columna por sitio) pensado para revisión manual y decidir cuándo comprar — incluyen `mejor_precio` y `mejor_sitio` calculados siempre a partir del scrape más reciente de cada sitio.

## Fuentes de datos

| Sitio | Estado | Notas |
|---|---|---|
| Gol (voegol.com.br) | ✅ funcionando | Usa `playwright-extra` + stealth para pasar el bloqueo anti-bot (Akamai), intercepta la respuesta del endpoint interno `flightcalendar` en vez de tratar de llamarlo directo (requiere un token que solo se genera navegando la UI real). Registra un `page.addLocatorHandler` para cerrar automáticamente el popup de "cambiar al sitio de Argentina" que puede reaparecer entre rutas |
| Aerolíneas Argentinas | ⏳ pendiente (prioridad alta) | Sitio oficial, protección anti-bot más liviana que las OTAs — candidato más simple después de Gol. Destraba además la ruta San Luis-Buenos Aires |
| LATAM | ⏳ pendiente (prioridad alta) | Pedido explícito para la cobertura de David (rutas a Brasil desde Buenos Aires y Santiago) |
| 123 Milhas | ⏳ pendiente | OTA con protección anti-bot fuerte |
| Max Milhas | ⏳ pendiente | Ídem |
| Despegar | ⏳ pendiente | OTA, protección anti-bot considerable |
| Google Flights | ⏳ pendiente | De los sitios más difíciles de scrapear en general, dejar para el final |

Cada scraper nuevo se agrega en `scrapers/<sitio>.js` (misma forma que `scrapers/gol.js`: exporta `run(routes)` y devuelve filas normalizadas) y se registra en el mapa `SCRAPERS` de `index.js`. Los sitios listados en `config/routes.json` que todavía no tienen scraper implementado se ignoran automáticamente (no rompen la corrida).

## Automatización (GitHub Actions)

`.github/workflows/scrape.yml` corre 3 veces por día (~cada 8h, con hasta 20 min de espera aleatoria para variar el horario exacto) y commitea `data/prices.csv` + los dos resúmenes automáticamente. No requiere que la PC esté prendida.

Para dispararlo manualmente: pestaña *Actions* del repo → *Scrape flight prices* → *Run workflow* (en ese caso salta la espera aleatoria).
