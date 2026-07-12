# vuelos-tracker

Trackea precios de vuelos.

Rutas, persona y tipo de viaje (`oneway`/`roundtrip`) configurables en [`config/routes.json`](config/routes.json). Ambos tipos de viaje escanean cada día del mes objetivo (el calendario de cada sitio ya devuelve el mes completo en una sola consulta); las rutas `roundtrip` usan `stayNights` (10 noches fijas) para emparejar cada día de ida con su vuelta, evitando la explosión combinatoria de probar todas las combinaciones de fechas posibles.

## Cómo correr localmente

```
npm install
npx playwright install chromium
npm run scrape
```

Esto actualiza:
- `data/prices/<YYYY-MM>.csv`: histórico crudo particionado por mes de scrapeo, una fila por sitio/ruta/fecha/corrida (nunca se sobreescribe, solo se agrega). Particionado para no chocar con el límite de 100MB por archivo de GitHub.
- `data/resumen-pablo.csv`, `data/resumen-david.csv` y `data/resumen-jessica.csv`: se regeneran enteros en cada corrida a partir del histórico. Formato pivotado (una fila por ruta+fecha(s), una columna por sitio) pensado para revisión manual y decidir cuándo comprar — incluyen `mejor_precio` y `mejor_sitio` calculados siempre a partir del scrape más reciente de cada sitio.
- `docs/data/`: los JSON que consume el sitio estático (ver abajo).

Variables útiles: `SITES=gol,aerolineas` limita qué sitios se scrapean; `EMAIL_MODE=none|digest|alerts` controla el envío de emails (default `digest`).

## Sitio estático (GitHub Pages)

`docs/` es un buscador estático servido por GitHub Pages (Settings → Pages → branch `master`, folder `/docs`): selector de ruta y fecha, precios actuales por sitio con equivalente en ARS y link de compra, gráfico de evolución histórica del precio (mínimo diario por sitio) y gráfico del mejor precio actual por fecha de salida. Los datos (`docs/data/index.json` + un JSON por ruta) los regenera `lib/siteData.js` en cada corrida del scraper y se commitean junto con el histórico; el sitio muestra cuándo fue la última actualización.

## Fuentes de datos

| Sitio | Estado | Notas |
|---|---|---|
| Gol (voegol.com.br) | ✅ funcionando | Usa `playwright-extra` + stealth para pasar el bloqueo anti-bot (Akamai), intercepta la respuesta del endpoint interno `flightcalendar` en vez de tratar de llamarlo directo (requiere un token que solo se genera navegando la UI real). Registra un `page.addLocatorHandler` para cerrar automáticamente el popup de "cambiar al sitio de Argentina" que puede reaparecer entre rutas |
| Aerolíneas Argentinas | ✅ funcionando | Deep-link directo a `flex-dates-calendar` (sin llenar formulario), intercepta la respuesta de `api.aerolineas.com.ar/v1/flights/offers`, que ya trae el mes completo de ida y vuelta en una sola consulta. También captura horarios/conexiones (guardados en `notes`), a diferencia de Gol |
| Google Flights | ✅ funcionando | Vía [SerpApi](https://serpapi.com) (250 búsquedas/mes gratis, sin key propia de Google), no scraping directo. Cubre 6 rutas de David (`bue-gyn`, `bue-bsb`, `bue-aep-gyn`, `bue-aep-bsb`, `scl-gyn`, `scl-bsb`) con 1 fecha representativa por ruta y 1 corrida/día (~180 búsquedas/mes) para no gastar la cuota gratuita — corre antes que Gol/Aerolíneas y el resto de las corridas del día reutilizan ese snapshot. Es también la única forma de ver precios de LATAM en el sitio/emails (no tenemos scraper propio, bloqueado por anti-bot — ver "Descartados" abajo): cuando SerpApi encuentra que LATAM es la opción más barata, el sitio lo muestra como "LATAM (vía Google Flights)" en vez de la etiqueta genérica. Requiere el secret `SERPAPI_KEY` en GitHub Actions; sin él, se salta silenciosamente. Se muestra en el email como sección aparte ("Todas las aerolíneas"), sin competir por `mejor_sitio` con Gol/Aerolíneas |

Cada scraper nuevo se agrega en `scrapers/<sitio>.js` (misma forma que `scrapers/gol.js`: exporta `run(routes)` y devuelve filas normalizadas) y se registra en el mapa `SCRAPERS` de `index.js`. Los sitios listados en `config/routes.json` que todavía no tienen scraper implementado se ignoran automáticamente (no rompen la corrida).

### Descartados

- **LATAM**: bloqueado por anti-bot (Akamai) incluso navegando "orgánicamente" desde el home antes de buscar — la sesión automatizada nunca recibe resultados reales, ni con el deep-link ni con la API interna del calendario de precios. Importante para leer los datos: **Santiago-Brasília (`scl-bsb`) la vuela LATAM, no Gol** -- por eso esa ruta nunca tuvo ni va a tener datos de Gol/Aerolíneas (no es un bug, no venden ese itinerario), y depende enteramente de que Google Flights encuentre a LATAM como resultado.
- **123 Milhas**: pendiente de reintentar. No tiene protección anti-bot fuerte (su API de precios responde bien a tráfico automatizado en rutas domésticas brasileñas), pero las consultas directas a esa API dieron 0 resultados para nuestras rutas internacionales. **Esa conclusión de "sin inventario" era incorrecta** (se puede comprar esa ruta ahora mismo en el sitio) — lo más probable es que la consulta necesite el flujo completo de navegador real en vez de la API directa, o algún parámetro que no se identificó. Queda para reinvestigar, no descartado en firme.
- **Max Milhas** y **Despegar**: nunca se llegaron a investigar (se priorizó LATAM y 123 Milhas primero); quedan fuera de los objetivos actuales por ahora.

## Automatización (GitHub Actions)

Tres workflows, todos con jitter aleatorio y minuto corrido (no `:00`) para esquivar la congestión de schedules de GitHub:

- `scrape-aerolineas.yml`: 8 veces por día (cada 3h). Aerolíneas es rápido y de bajo riesgo (intercepta la API pública del calendario flex), así que puede correr seguido.
- `scrape.yml` (Gol + Google Flights): 4 veces por día. Gol usa browser con stealth contra un sitio con anti-bot — más frecuencia sube el riesgo de bloqueo. Google Flights mantiene su límite interno de 1 corrida/día (cuota de SerpApi).
- `digest.yml`: 1 vez por día a la mañana, manda el email resumen completo sin scrapear (usa el histórico ya commiteado).
- `welcome-email.yml`: manual (`workflow_dispatch`, elegís la persona en un dropdown). Manda el email de bienvenida/onboarding una sola vez por persona (ver más abajo); no scrapea, solo regenera resúmenes desde el histórico ya commiteado.

Ambos workflows de scrape corren con `EMAIL_MODE=alerts` y commitean el histórico + resúmenes + `docs/data/` + `data/alerts-state.json`. Si dos corridas se pisan, el push reintenta con rebase; las particiones CSV usan `merge=union` (`.gitattributes`) porque son append-only.

Para disparar cualquiera manualmente: pestaña *Actions* → *Run workflow* (en corridas manuales el email va solo a Pablo, con prefijo "[TEST]" en el asunto — David y Jessica nunca reciben corridas de prueba).

## Emails: alertas + digest diario + bienvenida

- **Alertas** (`lib/alerts.js`): en cada corrida de scrape se evalúan solo las filas nuevas contra el histórico; se manda email únicamente si hay una oferta valiosa. Criterios (configurables por ruta en `config/routes.json`, campo opcional `alerts`): nuevo mínimo histórico, precio ≥15% debajo del promedio histórico (`percentBelowAvg`, con al menos 5 puntos de historia), caída ≥10% vs la corrida anterior (`dropPercent`), o precio debajo de un tope absoluto (`absoluteBelow: { price, currency }`, sin default). Cooldown de 24h por combinación ruta+fechas+sitio (`data/alerts-state.json`, commiteado), salvo que el precio siga cayendo ≥3%. Si muchas fechas de una misma ruta disparan a la vez (típico en una promo), se colapsan en una sola tarjeta con la fecha más barata + "otras N fechas". Nota: esto es distinto de "el precio más bajo del día" — el disparador es un umbral (mínimo histórico, % debajo del promedio, caída fuerte, o tope absoluto), no simplemente el mejor precio encontrado.
- **Digest diario** (`digest.yml`): el email resumen de siempre (dashboard, mejor precio por ruta, sección Google Flights, CSVs adjuntos), una vez por día como red de seguridad mientras se calibran los umbrales de alerta. El asunto siempre saluda por nombre ("Buenos días {Nombre}: acá está tu resumen diario ✈️"), con una variante si hubo nuevo mínimo o si bajaron precios. El link al sitio del tracker va en el pie de **todos** los emails (resumen, alerta y bienvenida), no solo en el primero.
- **Bienvenida** (`welcome-email.yml`, dispara `sendWelcomeEmail` en `lib/email.js`): email único por persona (marcador `data/welcomed-<persona>.json`, mismo patrón que `data/announcement-sent.json`) que explica cómo funciona el tracker (resumen diario, alertas, sitio web) y ya incluye el primer resumen real con los precios del día.

Todos requieren los secrets `GMAIL_USER`, `GMAIL_APP_PASSWORD` (contraseña de aplicación de Gmail), `PABLO_EMAIL`, `DAVID_EMAIL` y `JESSICA_EMAIL`; si falta alguno, el envío para esa persona se salta silenciosamente (el digest y las alertas de Pablo/David no dependen de que `JESSICA_EMAIL` esté configurado). Cada tarjeta incluye un link directo para comprar esa fecha/ruta en el sitio ganador, y si el precio está en reales muestra también su equivalente aproximado en pesos argentinos (cotización del día vía `open.er-api.com`, sin API key).
