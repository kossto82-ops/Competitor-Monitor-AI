# Fase 29 — Auditoría técnica y de producto + plan final de ejecución

Estado auditado: commit `1e617d6` (Fase 28.1). Auditoría de solo lectura: **no se modificó código**.
Método: lectura del código real por área (datos/detección/extracción, IA/worker/colas, seguridad/tenancy, UI/tests, docs/fases). El hallazgo C1 fue comprobado directamente; el resto procede de lectura de código y no se ejecutó ningún test. Partes no leídas: `fakeProvider`, `digestTypes`, `digestSchema`, tests de `scheduler` y `reportWindow`.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Email diario | 100 % determinista. La IA solo se ejecuta bajo demanda (acción explícita del usuario). |
| Proveedor de email | Genérico y configurable: SMTP estándar, utilizable con cualquier cuenta de cualquier empresa o persona. Sin dependencia de un proveedor concreto. |
| Cuotas y límites | Valores iniciales propuestos abajo, todos configurables por variable de entorno. |
| Autoría | Todos los commits y pushes son de `kossto82-ops`. Repositorio: `kossto82-ops/Competitor-Monitor-AI`. |
| Principios | Evidence-first. Deterministic first, AI second. Sin score de IA arbitrario. Sin microservicios. Sin reescritura. |

## Resumen ejecutivo

- Base sólida de monitorización con evidencia: fetch seguro (SSRF), snapshots, diff determinista de precios y promociones, before/after trazable, aislamiento multi-tenant y IA contenida (2 llamadas, ambas manuales y validadas).
- No es todavía Competitive Intelligence: en el dogfooding hay 6 ChangeEvents reales, ningún `PRICE_CHANGE` real, todos los patrones en `INSUFFICIENT_HISTORY` y 0 informes para la org real.
- Los mayores problemas son de fiabilidad (email stub, reintentos de IA descartados, precios invisibles sin JSON-LD, sin alertas ni ranking), no de falta de IA.
- Para llegar a Signals → Patterns → Insights faltan: identidad estable de entidades, una capa `Signal` y una taxonomía de capacidades. Todo es aditivo.

## Errores y defectos a corregir (registro completo)

### P0 — Bloqueantes

| ID | Área | Problema | Evidencia |
|---|---|---|---|
| E1 | Colas IA | `jobId` fijo + retención 7/30 días: BullMQ descarta el `add`. El "Refresh" del digest y el reintento de un análisis fallido nunca se ejecutan; la fila queda `PENDING` y la UI espera para siempre. Verificado. | `apps/web/src/app/api/digest/interpretation/route.ts:72`, `packages/queue/src/digestInterpretationQueue.ts:25`, `aiAnalysisQueue.ts:34`; el bug equivalente ya se corrigió en `monitoringQueue.ts:60-70` |
| E2 | Email | `createEmailProviderFromEnv` siempre devuelve `ConsoleEmailProvider`; el informe se marca `SENT` sin enviarse. | `packages/notifications/src/emailProvider.ts:38-59` |
| E3 | Abuso | Sin rate limit ni lockout en login/signup; signup revela emails registrados (409). Sin cuotas en scan, análisis y digest (gasto LLM sin tope). Sin tope de competidores/URLs por org. | `api/auth/login`, `api/auth/signup`, `scan/route.ts`, `analysis/route.ts`, `interpretation/route.ts` |
| E4 | Infra | Compose publica Postgres (5432) y Redis (6379) en todas las interfaces, credenciales por defecto, Redis sin contraseña (Redis = cola: se pueden inyectar jobs con cualquier `organizationId`). `dump.rdb` sin trackear y no está en `.gitignore`. | `docker-compose.yml:5-12`, `.env.example:2` |

### P1 — Altos

| ID | Área | Problema | Evidencia |
|---|---|---|---|
| E5 | Detección | Precios invisibles sin JSON-LD: las entidades `GENERIC` se excluyen del diff de precios; el cambio sale como `CONTENT_CHANGE` LOW, confianza 0.5. | `packages/detection/src/compare.ts:109,168` |
| E6 | Detección | Evidencia de `CONTENT_CHANGE` inútil: old/new son los primeros 300 caracteres de la página, no la zona cambiada. | `compare.ts:310-311` |
| E7 | Extracción | Hash de página completa: nav, footer, banners y contadores generan ruido y falsos `CONTENT_CHANGE`. | `structuredData.ts:13-21` |
| E8 | Extracción | Páginas JS (shell, confianza ≤0.3) se persisten y comparan como válidas; esqueleto vs. página completa da `PRODUCT_ADDED/REMOVED` falsos. La confianza no se propaga a detección. | `structuredData.ts:230-235`, `pipeline.ts` |
| E9 | Detección | `CHANGED` con cero eventos: `structuredDataHash` incluye el JSON-LD bruto; cambios no relevantes (ratings, fechas) producen estado cambiado sin evento. | `cheerioExtractor.ts:75`, `compare.ts:36-58` |
| E10 | Detección | Un evento de entidad suprime el `CONTENT_CHANGE` de la misma página (cambios de texto/features perdidos). | `compare.ts:48-51` |
| E11 | Detección | Identidad frágil: clave `jsonld:{name}`; renombrar = REMOVED+ADDED y se pierde el historial de precios; nombres duplicados colisionan; solo se lee `offers[0]`; promos HTML por texto de encabezado. | `structuredData.ts`, `htmlPromotions.ts`, `compare.ts:91` |
| E12 | Detección | Precios comparados como string (`10` vs `10.00` = cambio 0 %); `parseNumeric` rompe `1.299,00`; cambio solo de moneda ignorado; todo `$` = USD; solo €, $, £. | `compare.ts:77-83`, `structuredData.ts` |
| E13 | Detección | Confianza y severidad son constantes (0.95/0.8/0.75; promoción siempre MEDIUM); no derivan de la calidad de la extracción. Sin dedupe de valores oscilantes ni unicidad en `ChangeEvent`. | `compare.ts` |
| E14 | Scheduling | Sin límite por host ni jitter (5 URLs del mismo competidor pueden dispararse a la vez); sin detección de fuente obsoleta (`STALE`); backoff ignora `scanFrequencyMinutes` (una URL diaria que falla se reintenta cada 15 min); sin estado `DISABLED`; sin robots.txt; el scheduler es un proceso aparte, solo "dev/dogfood". | `scheduler.ts`, `monitoredUrls.ts:74-105` |
| E15 | IA/seguridad | Prompt injection parcial: el delimitador `</UNTRUSTED_WEB_CONTENT>` no se neutraliza; `entityKey`/`label` (texto de página) van en la zona de confianza; el análisis por cambio no tiene validador de salida; el truncado a 16 000 caracteres puede cortar la etiqueta de cierre. | `packages/ai/src/prompt.ts:80-109`, `digestPrompt.ts:116-133` |
| E16 | Sesión | JWT de 7 días sin revocación ni comprobación en BD; CSRF solo por `SameSite=Lax` (sin Origin check ni Content-Type obligatorio); cookie de logout sin atributos. | `lib/session.ts`, `lib/currentSession.ts:21`, `api/auth/logout/route.ts` |
| E17 | Cifrado | `CMA_AI_ENCRYPTION_KEY` acepta cualquier string (incluido el placeholder), derivada con SHA-256 sin salt; sin id de clave ni rotación; sin AAD (swap de ciphertext entre orgs). Sin validación de arranque de secretos. | `packages/security/src/credentialEncryption.ts:446-454` |
| E18 | Docs | README ("Phase 10", "no scheduler", "no promotion extraction") y DevRunbook ("no scheduler yet") obsoletos; Fases 26/27 afirman "no cost telemetry" pero el schema tiene `costUsd`/tokens; sin doc de 28.1. | `README.md`, `DevRunbook.md` |

### P2 — Medios

| ID | Área | Problema |
|---|---|---|
| E19 | IA | Digest "Refresh" sin hash de entrada: cada pulsación es una llamada de pago aunque no haya evidencia nueva. |
| E20 | IA | Las "observaciones" del digest y los "facts" de PRICE_CHANGE duplican cálculo determinista (`describeChangeEvent`); sobra IA. |
| E21 | IA | Nada dispara IA automáticamente → por decisión actual se mantiene bajo demanda; el email no debe mostrar "AI interpretation unavailable" sino omitir la sección. |
| E22 | IA | `pricing.ts` solo cubre `gpt-4o` y `gpt-4o-mini`; `costUsd=null` para el resto (sin control de presupuesto). |
| E23 | IA | Al análisis se envían los primeros 800 caracteres del snapshot, no la zona del cambio. |
| E24 | Worker | Fila `RUNNING` de IA sin sweeper si el job muere antes del evento `failed`; bloquea refresh indefinidamente. |
| E25 | Datos | `ExtractedEntity` sin `organizationId` (rompe la convención de tenant); mutaciones check-then-update no atómicas (usar `updateMany/deleteMany` con `organizationId`). |
| E26 | Datos | Snapshot completo (`normalizedContent`) por escaneo aunque no cambie; sin retención ni compactación. `raw` JSON-LD duplicado por entidad. |
| E27 | Patrones | Patrones solo por competidor y calculados en vivo; `sustainedCount` mezcla tendencias por encima y por debajo del baseline; los conteos "N de M" no nombran competidores; un patrón enlaza solo a su evento más reciente. |
| E28 | UX | Dashboard orientado a conteos y telemetría; sin jerarquía por importancia; evidencia sin diff de texto ni captura (texto recortado a 400 caracteres). |
| E29 | Tests | Sin CI; sin corpus de HTML real; sin tests de resiliencia (Redis/worker/Postgres caídos, envío de email fallido); 0 tests de componentes; rutas API sin tests (`auth/*`, `competitors`, `change-events`, `dashboard`, `monitoring-jobs`, `settings/organization`, `me`); sin e2e de `/reports` y settings; Playwright `retries: 0`. |
| E30 | Extracción | Cheerio parsea hasta 5 MB por escaneo concurrente (DoS en el worker); sin comprobación de content-type. |
| E31 | Seguridad | `competitor.website` y `baseUrl` aceptan `javascript:`/`data:`/`ftp:` (hoy solo se muestran como texto). `CMA_ALLOW_PRIVATE_TARGETS` depende solo de `NODE_ENV`. Sin cabeceras de seguridad (CSP, HSTS, X-Frame-Options, Referrer-Policy). |
| E32 | Fixtures | ~396 URLs de fixtures E2E fallan en cada tick; ~438 orgs, casi todas de test, en la BD de desarrollo. |

### P3 — Bajos

| ID | Problema |
|---|---|
| E33 | Sin roles: cualquier miembro edita credenciales de IA y ajustes. |
| E34 | Prisma 5.22 antiguo; `bcryptjs` en JS puro bloquea el event loop ante floods; ejecutar `npm audit`. |
| E35 | Política de contraseñas sin comprobación de filtraciones. |
| E36 | `Host` header sin puerto no estándar en `safeFetch`; IPv6 entre corchetes cae a DNS; solo se fija el primer registro A/AAAA (sin fallback). |
| E37 | Código muerto: `HttpExtractor`, `requiresJs`/`requiresInteraction`, `browserEscalated`, `EntityType.PRODUCT/PLAN` (nunca emitidos); enums duplicados a mano entre `core` y Prisma. |
| E38 | Evidencia de precio genérico con etiquetas de recortes de texto crudos; `classifyRequestError` por substring; `priceValidUntil` ambiguo (promo vs. caducidad rutinaria); Windows `EPERM` en `prisma generate` con el worker activo. |

## Valores propuestos de cuotas y límites (configurables por entorno)

| Límite | Valor inicial | Variable |
|---|---|---|
| Login: intentos fallidos | 10 / 15 min por IP + email | `CMA_LIMIT_LOGIN_ATTEMPTS`, `CMA_LIMIT_LOGIN_WINDOW_MIN` |
| Signup | 5 / hora por IP | `CMA_LIMIT_SIGNUP_PER_HOUR` |
| Escaneos manuales | 20 / hora por org | `CMA_LIMIT_MANUAL_SCANS_PER_HOUR` |
| Análisis de IA por cambio | 30 / día por org | `CMA_LIMIT_AI_ANALYSES_PER_DAY` |
| Interpretaciones de digest | 10 / día por org | `CMA_LIMIT_AI_DIGESTS_PER_DAY` |
| Test de conexión de IA | 10 / hora por org | `CMA_LIMIT_AI_TEST_PER_HOUR` |
| Competidores por org | 25 | `CMA_LIMIT_COMPETITORS_PER_ORG` |
| URLs monitorizadas por org | 100 | `CMA_LIMIT_URLS_PER_ORG` |
| Frecuencia mínima de escaneo | 60 min | `CMA_LIMIT_MIN_SCAN_INTERVAL_MIN` |

Respuesta al exceder: HTTP 429 con `Retry-After` y mensaje explicativo; los límites son por organización y no afectan a otras. Almacén de contadores: Redis (ya existente).

## Diseño del email configurable (A2)

- Proveedor SMTP genérico (nodemailer), válido con cualquier cuenta (empresa o personal): `CMA_EMAIL_SMTP_HOST`, `CMA_EMAIL_SMTP_PORT`, `CMA_EMAIL_SMTP_SECURE` (`true`/`false`/`starttls`), `CMA_EMAIL_SMTP_USER`, `CMA_EMAIL_SMTP_PASS`, `CMA_EMAIL_FROM`, `CMA_EMAIL_FROM_NAME`.
- Sin configurar: estado `NOT_CONFIGURED`, nunca `SENT`; el informe sigue generándose y visible en la web.
- Fase A2b (mismo bloque, después de A2): conexión SMTP **por organización** guardada cifrada con el mecanismo existente de credenciales (con las mejoras de E17), para que cada cliente envíe desde su propio correo. Incluye botón "enviar email de prueba" con límite de uso y SSRF-guard en el host SMTP.
- El contenido del email es 100 % determinista. La sección de IA solo aparece si el usuario ya generó una interpretación; si no, se omite (sin texto "unavailable").
- Fallo de envío: reintento por BullMQ, nunca tumba el informe, estado `FAILED` visible.

## Plan de ejecución por partes

Cada parte: rama o commit propio, tests en verde, y pausa para revisión antes de continuar. Todos los commits y pushes se hacen como `kossto82-ops` al repositorio `kossto82-ops/Competitor-Monitor-AI`.

### Fase A — Fiabilidad (2-3 semanas)

| Parte | Contenido | Errores | Verificación |
|---|---|---|---|
| A1 ✅ | Hecho: `addJobReplacingTerminal` (`packages/queue/src/enqueueJob.ts`) elimina el job terminal previo (completed/failed) y mantiene el dedup exacto de jobs en curso; usado en las rutas de digest y análisis | E1 | Test con Redis real (4 casos, incl. reproducción del bug): Refresh y reintento se ejecutan; sin duplicados en curso |
| A2 | Proveedor SMTP genérico, estados `NOT_CONFIGURED/SENT/FAILED`, email determinista sin sección de IA no solicitada | E2, E21 | Tests con fake SMTP; fallo de envío no tumba el informe |
| A2b | SMTP por organización cifrado, email de prueba | E2, E17 (parcial) | Tests de cifrado, aislamiento por org, SSRF del host |
| A3 | Rate limit y cuotas con los valores de arriba; signup sin filtrar emails; topes por org | E3 | Tests de API: 429, aislamiento entre orgs |
| A4 | Compose en 127.0.0.1, contraseña de Redis, credenciales fuera de defaults, `dump.rdb` en `.gitignore`, validación de arranque de `AUTH_SECRET` y `CMA_AI_ENCRYPTION_KEY` | E4, E17 (arranque), E31 (`ALLOW_PRIVATE`) | Test de arranque con valores inválidos |
| A5 | Neutralizar delimitadores, mover `entityKey/label` a zona no confiable, validador de afirmaciones en el análisis por cambio, no cortar etiquetas al truncar | E15 | Tests con páginas hostiles; el e2e de OpenAI sigue pasando |
| A6 | README/DevRunbook actualizados, doc de 28.1, CI (Postgres + Redis), limpieza de fixtures, restricción `http/https` en `website`/`baseUrl`, cabeceras de seguridad | E18, E29 (CI), E31, E32 | La CI pasa desde cero |

### Fase B — Monitorización autónoma y salud (2-3 semanas)

Scheduler de producción con frecuencia por fuente, límite por host y jitter, backoff relativo a la frecuencia configurada, estados `STALE`/`DISABLED`, requests condicionales (`ETag`/`If-Modified-Since`), robots.txt, límite de tamaño/content-type en extracción, sweeper de filas `RUNNING`, panel de salud de fuentes y alerta de fuente caída. Errores: E14, E24, E30, parte de E26.
Tests: corpus de comportamientos reales (403, 429, redirecciones), resiliencia (Redis/worker caídos).

### Fase C — Calidad de detección (3-4 semanas)

Extractor determinista de tarjetas/tablas de precio, parser de moneda y locale, normalización por regiones (main, sin nav/footer/banners), evidencia por bloque cambiado, supresión de oscilaciones, snapshot poco fiable → `FAILED_TO_VERIFY`, identidad interna por competidor (renombrado detectado con confianza), confianza y severidad derivadas, unicidad en `ChangeEvent`, `organizationId` en `ExtractedEntity`. Errores: E5-E13, E25, E26, E37.
Tests: corpus de HTML real versionado; la fase se mide por precisión/recall sobre el corpus.

### Fase D — Signals y priorización explicable (2-3 semanas)

Tablas `Entity/EntityVersion`, `Signal/SignalEvidence` (promoción solo por reglas sobre eventos verificados), prioridad explicable (magnitud, recencia, frecuencia, nº de competidores, categoría estratégica elegida por el cliente, relevancia del competidor, significancia histórica; desglose por factor, pesos configurables y versionados; **importance** separada de **confidence**), alertas con niveles definidos por reglas observables, deduplicación y explicación obligatoria, primer dashboard "qué debes saber hoy". Errores: E27, E28, E16 (sesión), E33.

### Fases posteriores (no implementar todavía)

| Fase | Contenido | Condición |
|---|---|---|
| E | Patrones de mercado (`Pattern` materializado, mínimos de muestra) | D + 4-8 semanas de histórico real con varios competidores |
| F | Features, planes, taxonomía de capacidades por org, clasificación semántica en lote con confianza | C + D |
| G | Vista ejecutiva con `Insight` (`epistemicLevel`: fact / interpretation / inference), amenazas y oportunidades etiquetadas como inferencia, battlecards ligeras | E + F |
| H | Escala: frecuencia adaptativa, dedupe de fetch compartido, retención/compresión de snapshots, navegador por demanda, métricas | Datos de uso real |

No implementar todavía: matching de identidad cross-competitor con IA, embeddings, AI visibility, forecasting, sentimiento, facturación, microservicios.

## Arquitectura objetivo (resumen)

- **Conservar:** `safeFetch`/SSRF, pipeline transaccional, `ChangeEvent` y evidencia before/after, extractor de promociones, tenant scoping, IA bring-your-own-key, "monitoring nunca llama a la IA", digest validado, informe determinista.
- **Modificar:** `compare.ts` (confianza/severidad derivadas, evidencia por bloque, moneda/locale), extractor (regiones, snapshot no fiable), colas de IA, notificaciones, scheduler.
- **Añadir (aditivo, mismo Postgres):** `Entity`, `Signal`, `SignalEvidence`, `Pattern`, `Insight`, `Capability`, `EntityCapability`, estados de salud de fuente, `AlertRule/AlertEvent`, `ImportanceConfig`; jobs `signals` y `patterns`.
- **Eliminar/refactorizar:** `HttpExtractor` si sigue sin uso, flags muertos, duplicación de enums (un único registro tipo → detector/descriptor/categoría).
- **Cadena de datos:** Source → Evidence → Raw Change → Verified Change → Signal → Pattern → Insight → Decision, cada flecha es una tabla con claves a la anterior; `epistemicLevel` obligatorio en Signal, Pattern e Insight.

## Estrategia de IA y coste

- Hoy solo 2 llamadas, ambas manuales (~$0,0005 en total medido). Se mantiene: monitoring no llama a la IA.
- Digest: hash del paquete de evidencia; si no cambió, se reutiliza el resultado. Hechos y observaciones numéricas por plantilla; la IA solo aporta interpretaciones e hipótesis.
- Futuro: IA solo en lotes de strings acotados (clasificación de features/promociones), una llamada por org y periodo para el resumen ejecutivo con entrada ya verificada; cuotas por org; precios de modelos configurables.
- Coste a escala (orden probable): navegador headless si se generaliza > almacenamiento de snapshots > proxies/anti-bot > LLM si se automatiza sin cuotas > email (despreciable). Requests = orgs × competidores × URLs × (1440 / frecuencia); la frecuencia adaptativa y las requests condicionales lo reducen 5-10×.

## Criterio de éxito de producto

Con 3-5 competidores reales y 4 semanas de datos, un ejecutivo recibe por email un resumen con 3 señales verificadas, con evidencia enlazada, que no habría encontrado por sí mismo. Es la prueba que las Fases 25-28 no pudieron demostrar.
