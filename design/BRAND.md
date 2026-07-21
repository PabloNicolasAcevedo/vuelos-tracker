# Marca: Chebora

Propuesta de marca para lo que hoy es técnicamente `vuelos-tracker`. Este documento define el
nombre, el lockup y el tratamiento tipográfico. **No implica renombrar el repo ni el package**:
`vuelos-tracker` sigue siendo el nombre técnico del proyecto; `Chebora` es la marca que ve la
persona que recibe el mail / entra al sitio.

## Nombre

**Chebora** — mezcla "che" (interjección bien argentina) con "bora" (slang brasilero de "vamos").
Nombra en una palabra el eje del producto: rutas Buenos Aires ↔ Brasil, para un grupo de personas
que hablan de "vamos" a estas rutas todo el tiempo. Corto, fácil de decir, no choca con marcas de
viajes existentes.

## Lockup (nombre + descriptor)

La marca sola (`Chebora`) no comunica qué es. Como Google Flights, Flightradar24 o Skyscanner,
necesita un descriptor al lado, en un peso/tamaño menor:

**Recomendado: `Chebora Tracker`**
- Conecta directo con el nombre técnico del proyecto (`vuelos-tracker`) — quien ya conoce el
  proyecto no pierde continuidad.
- "Tracker" ya es una palabra de uso común en productos de este tipo en castellano rioplatense
  (mezcla inglés/castellano es normal en travel-tech: Despegar, Almundo, 123milhas también lo hacen).

**Alternativas:**
- `Chebora Radar` — más evocador de "vigilancia activa de precios", encaja con el lenguaje de
  radar/monitoreo que ya usan los íconos del mail (`ICON_ROUTE`, `ICON_GLOBE`).
- `Chebora Vuelos` — 100% en castellano, más literal, menos distintivo.

En el mail, el lockup va en el header: `Chebora` en el peso más pesado del wordmark, `Tracker` en
un peso liviano y un tono más apagado al lado o debajo, sin separador visual pesado (ni "|", ni
guión) — un espacio y el cambio de peso/color alcanza.

## Tipografía del wordmark (el logo, por ahora)

No hay isotipo/ícono todavía — el logo es **solo tipografía**, bien estilizada. Se usa nada más
para el nombre de marca (header del mail, título del sitio), nunca como fuente de texto largo.

**Fuente: [Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk)**, peso 700/800.

Por qué:
- Geométrica, con carácter — moderna e impactante sin ser un display font extremo/ilegible.
- Gratuita en Google Fonts (mismo mecanismo `@import` que ya usa el mail para Plus Jakarta Sans:
  `lib/email.js:637` — cero fricción técnica para sumarla).
- Convive bien con Plus Jakarta Sans (la fuente de cuerpo actual): misma familia de grotescas
  geométricas, distinto carácter — es la combinación real que usan muchos productos travel/fintech
  modernos (heading distintivo + body neutro y legible).
- Tiene números tabulares prolijos, útil si el wordmark alguna vez comparte línea con un precio.

**Tratamiento:**
```
font-family: 'Space Grotesk', 'Plus Jakarta Sans', Arial, sans-serif;
font-weight: 800;
letter-spacing: -0.02em;   /* apretado, look "wordmark", no texto suelto */
```
`Chebora` en `COLOR_PRIMARY` (o `COLOR_TEXT` sobre fondo claro) + `Tracker` en el mismo font-family,
peso 500, `COLOR_TEXT_SECONDARY`, ~65% del tamaño de `Chebora`.

**Fallback para mail:** igual que hoy con Plus Jakarta Sans (ver comentario en `lib/email.js:626`),
muchos clientes de mail (apps móviles, Outlook) ignoran `@import` de Google Fonts. El fallback
(`Plus Jakarta Sans` en negrita, y si tampoco carga, `Arial` bold) tiene que verse aceptable — por
eso el tratamiento es tipografía + peso + tracking, no algo que dependa 100% de los rasgos
específicos de Space Grotesk para leerse bien.

## Tono de copy

Relajado y moderno, pero que transmita confianza — como Despegar (seriedad, dato concreto) más la
calidez informal de 123milhas (cercanía, sin ser gritón). En la práctica:

- **Frases directas, sin relleno.** "Nuevo mínimo histórico en los últimos 90 días" en vez de
  "¡Encontramos un precio increíble para vos! 🎉".
- **La urgencia la transmite el dato, no el signo de exclamación ni el emoji.** Un badge con color
  + texto conciso ("Bajó $12.400 desde la última actualización") ya comunica que vale la pena
  mirarlo — no hace falta "🔥" ni mayúsculas.
- **Nada de humor forzado ni jerga de venta agresiva** ("¡Última oportunidad!", "¡No te lo
  pierdas!"). El destinatario es alguien del círculo cercano (Pablo/David), no un lead frío
  — el tono es "te aviso porque te sirve", no "te vendo".
- Ver `design/email-design-system.md` para el detalle de qué reemplaza a cada emoji actual.
