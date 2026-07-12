# Sistema de diseño — mails de Chebora

Propuesta de diseño para los mails (`lib/email.js`), pensada para que la sesión que está migrando
a MJML la aplique al terminar. No modifica `lib/email.js` a propósito — evita choques con esa
migración en curso. Este documento + `design/tokens.json` son la fuente de verdad; `design/BRAND.md`
cubre nombre y wordmark.

**Inspiración:** 123milhas (cercanía, calidez, confianza en la oferta) + Despegar (seriedad,
prolijidad, celeste como color de confianza en viajes LatAm). El resultado no debería verse
como ninguno de los dos puntualmente, sino en ese punto medio: relajado pero serio.

**Regla dura: cero emojis.** En ningún lado — asunto, headers, badges, copy. Los mejores
buscadores (Google Flights, Skyscanner, Kayak) no usan emojis en tarjetas de vuelo; comunican
estado con color + ícono de línea + texto. El mail ya tiene la mitad de esa infraestructura
(`ICON_PLANE`, `ICON_ROUTE`, `ICON_GLOBE`, `ICON_TROPHY`, `ICON_TREND_DOWN` en `lib/email.js:211,
464-467`) — el trabajo es terminar de aplicarla donde todavía quedó un emoji suelto, no inventar
un sistema nuevo.

Las flechas Unicode simples (`↓ ↑ ↘ ↗`, ya usadas para deltas de precio) **no** son emoji —
son símbolos tipográficos, se ven igual en todos los clientes de mail sin depender de una fuente
de emoji del sistema operativo, y es exactamente el lenguaje visual que usa cualquier ticker de
precios. Se mantienen.

## 1. Marca en el mail

Hoy el header del mail es `<h2>✈️ ${title}</h2>` (`lib/email.js:642`), donde `title` es el
nombre de la sección (ej. "Precios de vuelos a Brasil — Octubre"). Eso hace que la marca nunca
aparezca — cada mail muestra solo el nombre de la ruta.

**Propuesta:** separar wordmark (fijo, siempre igual) de título de sección (variable):

```
Chebora Tracker                    <- wordmark, fijo en todos los mails
Precios de vuelos a Brasil — Octubre   <- title actual, ahora subordinado
```

- `Chebora` — Space Grotesk 800, `color.primary`, `wordmark.size` (22px).
- `Tracker` — Space Grotesk 500, `color.textSecondary`, `wordmarkSuffix.size` (14px), separado
  por un espacio (sin "|" ni guión).
- El `title` actual baja de 32px/800 a `emailTitle` (20px/700, `color.text`) — sigue siendo
  prominente, pero ya no compite con la marca.

Ver `design/BRAND.md` para la justificación de nombre y tipografía.

## 2. Color

Se mantiene casi todo lo que ya funciona en `lib/email.js:16-24` (primary, bg, surface, text,
border, success, danger) — son valores correctos y ya probados en producción. Los cambios:

- **Se unifica el dorado.** Hoy hay tres tonos de dorado/amarillo ligeramente distintos para el
  mismo concepto ("esto es una oferta/hito destacado"): `#b8860b` (badge de mínimo histórico,
  `lib/email.js:95`), `#8a6402`/`#fff7e0` (pills de motivo en el mail de alerta,
  `lib/email.js:700`), y el dorado de `ICON_TROPHY` (`#b8860b` también). Se reemplazan los tres
  por un único par `color.accent` (`#fef3e2` fondo / `#b45309` texto) — mismo rol semántico, un
  solo valor, se ve intencional en vez de "quedó así".
- **`color.info`** (`#eef2ff` fondo / `primary` texto) formaliza el celeste clarito que ya usan
  el tag "Ida y vuelta" (`buildTripTypeTag`) y los callouts de bienvenida/novedades — se
  mantiene, solo se le pone nombre para que sea reusable a propósito y no una coincidencia.
- Los colores de aerolínea (`AIRLINE_ACCENT_BY_IATA`, `lib/email.js:131-135`) se mantienen
  intactos — son colores reales de marca (Gol naranja, LATAM magenta, Aerolíneas azul marino),
  cumplen la misma función que el logo de aerolínea en Google Flights/Skyscanner y no deben
  tocarse por estética.

Ver `design/tokens.json` → `color`.

## 3. Tipografía

- **Cuerpo/UI:** Plus Jakarta Sans, sin cambios — ya está cargada (`lib/email.js:637`) y
  funciona bien como fallback (Arial) cuando el cliente de mail no soporta `@import`.
- **Wordmark (solo el nombre de marca):** Space Grotesk, ver `design/BRAND.md`.
- Ninguna otra fuente nueva. El resto de la escala tipográfica (24px headings de sección, 28px
  precio, 14px cuerpo, 12-13px micro-labels en mayúscula) se mantiene tal cual está hoy — ya es
  una escala consistente y "confiada" (números grandes para el precio, labels chicas en
  mayúscula para metadata, como cualquier buscador serio).

## 4. Radios y espaciado

- **Cards:** `8px` → **`12px`**. Un radio un poco más generoso lee como 2024+ (Despegar,
  Booking, Google Flights actuales usan 12-16px en cards); 8px hoy en todo (card, botón, badge)
  hace que todo se sienta un poco más "flat/2018".
- **Botones (CTA "Ver y comprar"):** se mantienen en `8px` — un poco más angostos que la card
  para que el botón lea como elemento accionable, no como otro bloque de contenido.
- **Pills/badges:** `999px` (full-round), sin cambios.
- **Espaciado:** confirma el sistema de múltiplos de 8px que ya está implícito en el código
  (4/8/12/16/24/32) — no hay que inventar nada, solo mantenerlo al portar a MJML.

## 5. Iconografía — reemplazo de cada emoji

Inventario completo de emojis actuales en `lib/email.js` y su reemplazo. Todo lo que no es un
ícono funcional (trofeo, tendencia) se **elimina sin reemplazo** — el texto solo, bien
jerarquizado, ya comunica lo mismo sin ruido visual. Es la misma lógica que ya siguieron con el
ícono del avión de conexión (`ICON_PLANE`, comentario en `lib/email.js:208-210`): SVG inline
tabler-icons-style donde haga falta un ícono, texto plano donde no.

| Línea | Hoy | Contexto | Reemplazo |
|---|---|---|---|
| `email.js:95` | `🏆 Nuevo mínimo histórico` | `buildBadgeHtml` — badge en la card | Pill con `color.accent` (fondo `#fef3e2`, texto `#b45309`) + `ICON_TROPHY` inline (el mismo SVG que ya se usa en el chip del dashboard, `email.js:466` — hoy están inconsistentes, uno usa emoji y el otro SVG para el mismo concepto) |
| `email.js:392, 585, 715` | `📍 ${ruta}` | Header de cada card de vuelo (3 lugares) | Sin ícono. `${ruta}` bold, tal cual. El pin es redundante — ningún buscador serio le pone pin al nombre de la ruta, la flecha `→` en el texto ya indica origen/destino |
| `email.js:605` | `📡 Todas las aerolíneas (Google Flights)` | `<h3>` de sección | Sin ícono, texto plano. El subtítulo debajo ya aclara que es una foto de una vez al día |
| `email.js:617-619` | `✈️`/`🔥` en el saludo del asunto (`buildSubject`) | Asunto del mail diario | Texto plano, sin prefijo pictográfico — ver §6 |
| `email.js:642` | `✈️ ${title}` | `<h2>` principal del mail | Reemplazado por el wordmark + title jerarquizado, ver §1 (no queda ningún ícono suelto acá) |
| `email.js:648` | `🔗 Todas las rutas...` | Línea de link al sitio, al pie | Sin ícono. `<a>` ya es visualmente un link (color primary + subrayado del cliente de mail), no hace falta marcarlo con 🔗 |
| `email.js:768` | `🔥 Alerta: ...` | Asunto del mail de alerta | Texto plano: `Alerta: BUE → GYN a $XXX` — el badge/pill de "por qué" ya está dentro del mail (`reasonsHtml`, `email.js:697-702`), no hace falta duplicar la urgencia en el asunto con un emoji |
| `email.js:794` | `✨ Novedades en el tracker` | Callout de novedades (one-shot) | Sin ícono. "Novedades en Chebora" — el fondo `color.info` de la caja ya la distingue del resto del mail |
| `email.js:821` | `👋 ¡Bienvenida, ${name}!` | Callout de onboarding | Sin ícono. El signo de exclamación + nombre ya da la calidez, no hace falta el saludo con la mano |
| `email.js:878` | `¡Bienvenida, ${name}! 👋 ...` | Asunto del mail de bienvenida | `¡Bienvenida, ${name}! Así funciona Chebora` |

Ícono nuevo a sumar al set existente (mismo estilo tabler-icons, mismo patrón que
`ICON_TROPHY`/`ICON_TREND_DOWN` en `email.js:464-467`):

- `ICON_TREND_UP` — hoy sólo existe `ICON_TREND_DOWN` (usado para "bajaron precios" en el chip
  del dashboard); si en algún momento se quiere un chip equivalente para subas, falta el mirror.
  No es urgente si nunca se usa un chip de "subieron precios" en el dashboard.

## 6. Copy de asuntos (subject lines)

El asunto es lo más visible de todo el sistema — es lo que se ve en la lista del inbox antes de
abrir nada, y es donde más "ensucia" un emoji (además de leer como spam/newsletter agresivo en
Gmail). Reescritura sin emoji, manteniendo la lógica de prioridad que ya tiene `buildSubject`
(`email.js:616-621`: mínimo histórico > bajó precio > rutina):

- Nuevo mínimo: `Chebora: nuevo mínimo histórico — resumen de hoy para ${name}`
- Bajó precio: `Chebora: bajaron precios — resumen de hoy para ${name}`
- Rutina: `Chebora: resumen de hoy para ${name}`
- Alerta: `Chebora: ${origin} → ${destination} a ${precio}${extra}`
- Bienvenida: `¡Bienvenida, ${name}! Así funciona Chebora`

El prefijo `Chebora:` reemplaza al `[TEST]`/emoji como forma de identificar el mail de un
vistazo en el inbox — más profesional que un emoji, igual de reconocible.

## 7. Componentes (spec para portar a MJML)

Los componentes ya están bien resueltos en `lib/email.js` — usan `<table>` en vez de flex a
propósito por compatibilidad entre clientes (comentario en `email.js:197-199`), y evitan
`box-shadow` (no confiable en mail, se sostienen con borde + barra superior de color de
aerolínea). **Mantener ambas decisiones al migrar a MJML** — no es deuda técnica, es la forma
correcta de hacer HTML de mail.

### 7.1 Card de vuelo (el componente principal)

Estructura implementada en `buildTripCardMjml` (`lib/email.js`), compartida por las cards de
resumen, Google Flights y alerta, con los ajustes de este documento:

1. Borde `color.border` 1px + borde superior 4px del color de la aerolínea. Radio `radius.card`
   (12px, no 8px).
2. Header: ruta en bold (`cardRouteTitle`, 18px — sin pin, ver §5), tag de tipo de viaje
   (`buildTripTypeTag`, pill `color.info`) y badge de aerolínea en la misma línea, debajo del
   título (no a la derecha en una columna aparte).
3. Tramo(s): salida/llegada con el ícono de avión como separador inline (`ICON_PLANE`) en una
   sola línea de texto, en vez de 3 columnas con conector centrado; separador punteado entre
   ida y vuelta si es roundtrip.
4. Badge de hito (mínimo histórico / delta de precio) — ver reemplazo de `color.accent` en §5.
5. Footer: precio grande (28px bold) + conversión ARS/BRL chica debajo, seguido del botón CTA
   en su propia fila a ancho completo debajo (no a la derecha en una columna angosta).

**Desviación de la spec original (puntos 2 y 3/5 de más arriba, que planteaban mantener el
layout de columnas existente sin cambios):** al migrar a MJML se detectó en dispositivo real
(Gmail para Android) que las cards con 3 columnas (tramo salida/conector/destino) y con el botón
CTA metido en una columna angosta (35%) se rendereaban mal -- contenido colapsado, huecos en
blanco, elementos superpuestos -- mientras que filas más simples de 2 columnas de solo texto (el
mismo patrón que usan las mini-cards del dashboard, `buildDashboardRouteBoxMjml`) sí renderizaban
bien. La causa exacta dentro de Gmail Android no se pudo aislar sin acceso al dispositivo, pero
el patrón "columnas simples con texto, nada de columnas de 3 ni botón en columna angosta" es el
que se confirmó funcionando, así que las cards ahora siguen ese patrón. Si en el futuro se
confirma que el problema era otra cosa puntual, se puede volver al layout de 2 columnas
lado a lado para el footer.

### 7.2 Dashboard/resumen (arriba del mail)

`buildDashboardHtml` (`email.js:479-498`) — grilla de 2 columnas de mini-cards por ruta +
chips de stats agregados abajo. Ya usa solo SVG (`ICON_ROUTE`, `ICON_GLOBE`, `ICON_TROPHY`,
`ICON_TREND_DOWN`), no requiere cambios de iconografía — solo el radio de las mini-cards pasa a
`radius.card`.

### 7.3 Callouts (bienvenida / novedades)

`buildOnboardingHtml`/`buildAnnouncementHtml` (`email.js:791-830`) — caja `color.info`, sin
ícono (ver §5), mismo radio `radius.card`.

## 8. Qué no cambia

Para que quede explícito y no se reinterprete de más al portar:

- La estructura de datos y toda la lógica de negocio (`buildRouteCards`, historial, alertas,
  agrupación BUE, etc.) — esto es puramente visual/copy.
- El uso de `<table>` para layout multi-columna.
- El forzado de `color-scheme: light only` (`email.js:623-625`) — sigue siendo necesario por el
  mismo motivo (Gmail mobile dark-mode invierte los colores elegidos a mano).
- Los colores de aerolínea reales (Gol/LATAM/Aerolíneas).
- Las flechas Unicode de tendencia (`↓ ↑ ↘ ↗`) — no son emoji, se quedan.
