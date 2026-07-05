# vuelos-tracker

Trackea precios de vuelos para dos personas y dos configuraciones distintas:

**Pablo — octubre 2026, solo ida, solo Gol**
- Buenos Aires Ezeiza (EZE) - Goiânia (GYN)
- Buenos Aires Ezeiza (EZE) - Brasília (BSB)
- Buenos Aires Aeroparque (AEP) - Goiânia (GYN)
- Buenos Aires Aeroparque (AEP) - Brasília (BSB)

**David — diciembre 2026 / enero-febrero 2027, ida y vuelta, todas las rutas y sitios**
- Buenos Aires Ezeiza (EZE) - Goiânia (GYN)
- Buenos Aires Ezeiza (EZE) - Brasília (BSB)
- Buenos Aires Aeroparque (AEP) - Goiânia (GYN)
- Buenos Aires Aeroparque (AEP) - Brasília (BSB)
- Santiago (SCL) - Goiânia (GYN)
- Santiago (SCL) - Brasília (BSB)
- San Luis (LUQ) - Buenos Aires (AEP)

Rutas, persona y tipo de viaje (`oneway`/`roundtrip`) configurables en [`config/routes.json`](config/routes.json). Ambos tipos de viaje escanean cada día del mes objetivo (el calendario de cada sitio ya devuelve el mes completo en una sola consulta); las rutas `roundtrip` usan `stayNights` (10 noches fijas) para emparejar cada día de ida con su vuelta, evitando la explosión combinatoria de probar todas las combinaciones de fechas posibles.

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
| Aerolíneas Argentinas | ✅ funcionando | Deep-link directo a `flex-dates-calendar` (sin llenar formulario), intercepta la respuesta de `api.aerolineas.com.ar/v1/flights/offers`, que ya trae el mes completo de ida y vuelta en una sola consulta. También captura horarios/conexiones (guardados en `notes`), a diferencia de Gol |
| Google Flights | ✅ funcionando | Vía [SerpApi](https://serpapi.com) (250 búsquedas/mes gratis, sin key propia de Google), no scraping directo. Solo cubre las 4 rutas de Buenos Aires de David (`bue-gyn`, `bue-bsb`, `bue-aep-gyn`, `bue-aep-bsb`) con 1 fecha representativa por ruta y 1 corrida/día (~120 búsquedas/mes) para no gastar la cuota gratuita — corre antes que Gol/Aerolíneas y el resto de las corridas del día reutilizan ese snapshot. Requiere el secret `SERPAPI_KEY` en GitHub Actions; sin él, se salta silenciosamente. Se muestra en el email como sección aparte ("Todas las aerolíneas"), sin competir por `mejor_sitio` con Gol/Aerolíneas |

Cada scraper nuevo se agrega en `scrapers/<sitio>.js` (misma forma que `scrapers/gol.js`: exporta `run(routes)` y devuelve filas normalizadas) y se registra en el mapa `SCRAPERS` de `index.js`. Los sitios listados en `config/routes.json` que todavía no tienen scraper implementado se ignoran automáticamente (no rompen la corrida).

### Descartados

- **LATAM**: bloqueado por anti-bot (Akamai) incluso navegando "orgánicamente" desde el home antes de buscar — la sesión automatizada nunca recibe resultados reales, ni con el deep-link ni con la API interna del calendario de precios.
- **123 Milhas**: no tiene protección anti-bot fuerte (su API de precios responde bien a tráfico automatizado en rutas domésticas brasileñas), pero **no vende ninguna de nuestras rutas** — ni siquiera EZE→GRU, una ruta internacional muy operada. No tiene sentido scrapear un sitio con cero inventario para lo que trackeamos.
- **Max Milhas** y **Despegar**: nunca se llegaron a investigar (se priorizó LATAM y 123 Milhas primero, y ambos resultaron no viables); quedan fuera de los objetivos actuales.

## Automatización (GitHub Actions)

`.github/workflows/scrape.yml` corre 3 veces por día (~cada 8h, con hasta 20 min de espera aleatoria para variar el horario exacto) y commitea `data/prices.csv` + los dos resúmenes automáticamente. No requiere que la PC esté prendida.

Para dispararlo manualmente: pestaña *Actions* del repo → *Scrape flight prices* → *Run workflow* (en ese caso salta la espera aleatoria y el envío de email se limita solo a Pablo, marcado como "[PRUEBA]" en el asunto — David nunca recibe corridas manuales de prueba).

## Email

Al final de cada corrida se manda un email con el mejor precio encontrado por ruta (no la tabla completa, esa va adjunta como CSV). Requiere los secrets `GMAIL_USER` y `GMAIL_APP_PASSWORD` en GitHub Actions (contraseña de aplicación de Gmail); si no están configurados, el envío se salta silenciosamente. Cada tarjeta incluye un link directo para comprar esa fecha/ruta en el sitio ganador, y si el precio está en reales muestra también su equivalente aproximado en pesos argentinos (cotización del día vía `open.er-api.com`, sin API key).
