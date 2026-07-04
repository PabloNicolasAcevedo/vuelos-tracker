# vuelos-tracker

Trackea precios de vuelos ida y vuelta (ARS/BRL) para:

- Buenos Aires (EZE) - Goiânia (GYN)
- Buenos Aires (EZE) - Brasília (BSB)
- Santiago (SCL) - Goiânia (GYN)
- Santiago (SCL) - Brasília (BSB)
- San Luis (LUQ) - Buenos Aires (AEP)

Rutas y meses configurables en [`config/routes.json`](config/routes.json). Fechas de búsqueda (día de salida + noches) en [`config/searchDates.json`](config/searchDates.json).

## Cómo correr localmente

```
npm install
npx playwright install chromium
npm run scrape
```

Los resultados se van agregando a `data/prices.csv` (una fila por sitio/ruta/fecha/corrida).

## Fuentes de datos

| Sitio | Estado | Notas |
|---|---|---|
| Gol (voegol.com.br) | ✅ funcionando | Usa `playwright-extra` + stealth para pasar el bloqueo anti-bot (Akamai), intercepta la respuesta del endpoint interno `flightcalendar` en vez de tratar de llamarlo directo (requiere un token que solo se genera navegando la UI real) |
| 123 Milhas | ⏳ pendiente | Sitio con protección anti-bot fuerte, falta implementar |
| Max Milhas | ⏳ pendiente | Ídem |
| Aerolíneas Argentinas | ⏳ pendiente | El buscador de fechas no muestra precios inline como Gol; falta resolver el flujo de selección de ida/vuelta |
| Despegar | ⏳ pendiente | Falta implementar |
| Google Flights | ⏳ pendiente | Falta implementar |

Cada scraper nuevo se agrega en `scrapers/<sitio>.js` (misma forma que `scrapers/gol.js`: exporta `run(routes)` y devuelve filas normalizadas) y se registra en el mapa `SCRAPERS` de `index.js`.

## Automatización (GitHub Actions)

`.github/workflows/scrape.yml` corre 3 veces por día (~cada 8h, con hasta 20 min de espera aleatoria para variar el horario exacto) y commitea los resultados nuevos a `data/prices.csv` automáticamente. No requiere que la PC esté prendida.

Para dispararlo manualmente: pestaña *Actions* del repo → *Scrape flight prices* → *Run workflow*.
