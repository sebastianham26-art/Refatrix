# Contrato API — Estatus del pedido (ERP → Portal/CRM)

**Versión 1.1 · 26 de octubre de 2026 · REFATRIX**

> **Qué cambia respecto a la v1.0:** se agregan dos **estatus finales**:
> `expirado` (secuencia **8**) y `eliminado` (secuencia **9**). El endpoint, la llave, el formato
> del cuerpo y la regla "sólo avanza" **no cambian**. Lo único que deben ajustar del lado del portal
> es **aceptar estos dos códigos** (hoy responderían `400 ERR_VALIDATION`) y mostrarlos.

Este documento describe el endpoint que **el portal (CRM) debe exponer** para que el ERP le avise
cada vez que un pedido cambia de etapa. Es el mismo esquema que ya usan para recibir las
condiciones comerciales del cliente (`customer-commercial`): **el ERP llama, el portal recibe.**

---

## 1. Etapas y estatus finales

### 1.1 Las 4 etapas del pedido (sin cambios)

| `secuencia` | `estatus` | `estatusTexto` (para mostrar) | Cuándo lo envía el ERP |
|:--:|---|---|---|
| 1 | `solicitud_nueva` | **Solicitud nueva** | La cotización que mandó el portal llegó bien al ERP y quedó registrada como cotización |
| 2 | `surtiendo` | **Surtiendo** | El almacén imprimió la orden de surtido: el pedido entró a empaque |
| 3 | `preparando_despacho` | **Preparando despacho** | El empaque terminó y el pedido espera la emisión de la factura (SAT) |
| 4 | `oc_enviada` | **OC Enviada** | Se registró el folio fiscal SAT de la factura y el pedido pasó a cobranza |

### 1.2 Estatus finales (nuevo en v1.1)

| `secuencia` | `estatus` | `estatusTexto` | Cuándo lo envía el ERP |
|:--:|---|---|---|
| 8 | `expirado` | **Expirado** | La cotización **venció por la regla de 24 horas** del ERP (no se imprimió la orden de surtido a tiempo y se liberó el inventario apartado) |
| 9 | `eliminado` | **Eliminado** | **Dirección aprobó eliminar** la cotización en el ERP |

- Son **finales**: después de un `8` o un `9` **ya no llega ninguna etapa** para ese pedido.
- Una cotización expirada **puede eliminarse después** → recibirán `8` y luego `9`.
- Un pedido puede eliminarse estando en `1`, `2` o `3` (nunca después de `4`: una cotización ya
  facturada no se puede eliminar).
- La **solicitud** de borrado no se envía — sólo la **aprobación**. Si dirección rechaza el borrado,
  no llega nada y el pedido sigue en su etapa.
- **Cancelaciones** siguen sin enviarse.
- Los números 5 a 7 quedan reservados para futuras etapas intermedias.

**Sólo enviamos pedidos que nacieron en el portal** (los que llegaron con folio `COT-…`).

## 2. Endpoint y autenticación (sin cambios)

```
POST https://www.refatrix.com.mx/api/integrations/erp/order-status?apiKey=<llave>
Content-Type: application/json; charset=utf-8
Accept: application/json
```

| | Producción | Pruebas |
|---|---|---|
| URL | `https://www.refatrix.com.mx/api/integrations/erp/order-status` | `http://138.197.25.94/api/integrations/erp/order-status` |

- **Mismo servidor y misma API key** que `…/api/integrations/erp/customer-commercial`.
- Los estatus finales llegan **por el mismo endpoint y con el mismo método `POST`** — no es un `DELETE`.

## 3. Cuerpo de la petición

Etapa normal (ejemplo, etapa 2):

```json
{
  "eventoId": "ERP-142-2",
  "cotizacionCrm": "COT-20260917120000001",
  "cotizacionErp": "COT-20260917120000001",
  "rfc": "AIAC8310204A0",
  "estatus": "surtiendo",
  "estatusTexto": "Surtiendo",
  "secuencia": 2,
  "fechaEstatus": "2026-09-23T16:05:12Z",
  "transactionUser": "admin"
}
```

Expirado (regla de 24 h — lo genera el sistema):

```json
{
  "eventoId": "ERP-143-8",
  "cotizacionCrm": "COT-20261025093000002",
  "cotizacionErp": "COT-20261025093000002",
  "rfc": "AIAC8310204A0",
  "estatus": "expirado",
  "estatusTexto": "Expirado",
  "secuencia": 8,
  "fechaEstatus": "2026-10-26T15:30:00Z",
  "transactionUser": "erp"
}
```

Eliminado (aprobado por dirección):

```json
{
  "eventoId": "ERP-144-9",
  "cotizacionCrm": "COT-20261026101500003",
  "cotizacionErp": "COT-20261026101500003",
  "rfc": "AIAC8310204A0",
  "estatus": "eliminado",
  "estatusTexto": "Eliminado",
  "secuencia": 9,
  "fechaEstatus": "2026-10-26T18:02:41Z",
  "transactionUser": "sebastian"
}
```

| Campo | Tipo | Siempre viene | Descripción |
|---|---|:--:|---|
| `eventoId` | string | **Sí** | `ERP-<id interno>-<secuencia>`. **Si llega repetido, es un reintento: respondan `0` y no hagan nada más** |
| `cotizacionCrm` | string | **Sí** | Su folio `COT-…`. **Llave para encontrar el pedido en el portal** |
| `cotizacionErp` | string | **Sí** | Número de cotización en el ERP (normalmente el mismo `COT-…`) |
| `rfc` | string | **Sí** | RFC del cliente |
| `estatus` | string | **Sí** | `solicitud_nueva` · `surtiendo` · `preparando_despacho` · `oc_enviada` · **`expirado`** · **`eliminado`** |
| `estatusTexto` | string | **Sí** | Texto listo para mostrar al cliente |
| `secuencia` | integer | **Sí** | 1 a 4 = etapas · **8 = expirado · 9 = eliminado**. **Nunca retrocede** |
| `fechaEstatus` | string | **Sí** | Cuándo ocurrió **en el ERP** (UTC, termina en `Z`). En `expirado`: la hora en que venció. En `eliminado`: la hora de la aprobación |
| `folioSat` | string | Sólo en 4 | Folio fiscal SAT de la factura |
| `ordenCompraCliente` | string | Si existe | Orden de compra del cliente |
| `transactionUser` | string | **Sí** | Usuario del ERP que originó el cambio. `erp` si fue automático (siempre en `expirado`); en `eliminado` es el director que aprobó |

**Campos opcionales vacíos no se envían.**

## 4. Reglas que el portal debe respetar

1. **La etapa sólo avanza.** Guarden la `secuencia` más alta. Si llega una **menor o igual**,
   respondan `0` y **no cambien nada**. Como `8` y `9` son los números más altos, esta misma regla
   garantiza que un reintento atrasado (por ejemplo un `2`) **nunca** "reviva" un pedido expirado
   o eliminado.
2. **Puede haber saltos.** Por ejemplo `1` → `8` (llegó y venció), o `1` → `2` → `9`.
   Si el portal activó la integración tarde, puede recibir directamente `8` o `9` sin haber
   recibido antes el `1` — el pedido de todos modos existe en el portal (nació ahí).
3. **Varias etapas pueden llegar seguidas**, en orden de `secuencia`.
4. Usen `fechaEstatus` para mostrar "desde cuándo".
5. **Nuevo:** con `expirado` o `eliminado`, el pedido debe mostrarse **cerrado** (no "en proceso").
   Sugerimos que el portal ofrezca al cliente **volver a cotizar**.

## 5. Respuesta esperada (sin cambios)

```json
{ "codigoError": "0", "mensaje": "Estatus actualizado" }
```

| HTTP | `codigoError` | Cuándo |
|---|---|---|
| 401 | `ERR_API_KEY` | Llave ausente o inválida |
| 404 | `ERR_PEDIDO_NOT_FOUND` | No existe un pedido con ese `cotizacionCrm` |
| 400 | `ERR_VALIDATION` | Falta un campo obligatorio o el `estatus` no es **uno de los 6** |
| 500 | `ERR_INTERNAL` | Error interno del portal |

Un aviso **repetido** o **atrasado** no es error: respondan `200` con `codigoError: "0"`.

## 6. Reintentos del lado del ERP (sin cambios)

- Cada estatus sale **en el momento** en que ocurre (vencimiento o aprobación del borrado).
  Además, cada 90 s el ERP revisa y envía lo que se haya quedado sin enviar.
- Reintentos a los **30 s · 2 min · 10 min · 30 min · 2 h · 6 h**, siempre con el mismo `eventoId`.

## 7. Prueba sugerida para la v1.1

1. Envíen (o esperen) un `expirado` a un pedido en `1` → responde `0` y el pedido queda **Expirado**.
2. Después envíen `secuencia: 2` al mismo pedido → responde `0` y el pedido **sigue Expirado**.
3. Envíen `eliminado` a un pedido expirado → responde `0` y queda **Eliminado**.
4. Reenvíen el mismo `eliminado` → responde `0`, sin cambios.

**Al activar la v1.1** el ERP envía de una vez `expirado` / `eliminado` para los pedidos del
portal de los **últimos 120 días** que ya estaban en esa situación, para que el portal quede al día.

## 8. Qué necesitamos de ustedes

> 1. Aceptar `expirado` (8) y `eliminado` (9) en el endpoint actual — sin cambiar URL ni llave.
> 2. Mostrarlos como pedido **cerrado**.
> 3. Mantener la regla "sólo avanza" tal como está.
