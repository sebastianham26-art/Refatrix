// =====================================================================
// Refatrix ERP · altaClientesForm.js — 「영업 > 고객개발」 Alta de clientes 양식 정의 (v1)
//   원본: FORMATO_ALTA_CLIENTES_FINAL.xlsx · Hoja1 (디렉터 제공 2026-11-24)
//   v2 (2026-11-25): 「Tamaño del cliente」(매장·창고·직원·영업·배송) · 「Potencial」(월 매출·구매 총액/서스펜션) 섹션 추가
//   · fill: denue(방문 전 자동 채움) / ia(녹음 분석이 채움) / manual(수기·서류)
//   · erp_field: 고객 등록(Registrar como cliente) 때 customers 쪽으로 넘길 항목
//   항목을 바꾸려면 이 파일의 version 을 올리고 sections 를 고친다(저장된 값은 form_version 과 함께 남는다).
// =====================================================================
export const ALTA_FORM = {
  "form": "alta_clientes",
  "version": 2,
  "source": "FORMATO_ALTA_CLIENTES_FINAL.xlsx · Hoja1 (Alta de clientes) + Tamaño del cliente / Potencial (2026-11-25)",
  "fill_sources": {
    "denue": "precargado desde el prospecto DENUE antes de la visita",
    "ia": "lo llena el análisis existente de la grabación (Desarrollo de clientes)",
    "manual": "solo captura manual o documentos; la IA no lo llena"
  },
  "sections": [
    {
      "key": "datos_generales",
      "label_es": "Datos Generales",
      "fields": [
        {
          "key": "nombre_cuenta",
          "label_es": "Nombre de la Cuenta",
          "type": "text",
          "required": true,
          "fill": [
            "denue",
            "ia"
          ],
          "denue_col": "nom_estab",
          "erp_field": "nombre_comercial"
        },
        {
          "key": "calle",
          "label_es": "Calle",
          "type": "text",
          "required": true,
          "fill": [
            "denue"
          ],
          "denue_col": "tipo_vial+nom_vial",
          "erp_field": "direccion_calle"
        },
        {
          "key": "numero",
          "label_es": "Número",
          "type": "text",
          "required": true,
          "fill": [
            "denue"
          ],
          "denue_col": "numero_ext+numero_int",
          "erp_field": "direccion_numero"
        },
        {
          "key": "colonia",
          "label_es": "Colonia",
          "type": "text",
          "required": true,
          "fill": [
            "denue"
          ],
          "denue_col": "nomb_asent",
          "erp_field": "direccion_colonia"
        },
        {
          "key": "codigo_postal",
          "label_es": "Código Postal",
          "type": "text",
          "pattern": "^[0-9]{5}$",
          "required": true,
          "fill": [
            "denue"
          ],
          "denue_col": "cod_postal",
          "erp_field": "direccion_cp"
        },
        {
          "key": "ciudad",
          "label_es": "Ciudad",
          "type": "text",
          "required": true,
          "fill": [
            "denue"
          ],
          "denue_col": "municipio",
          "erp_field": "direccion_ciudad"
        },
        {
          "key": "estado",
          "label_es": "Estado",
          "type": "text",
          "required": true,
          "fill": [
            "denue"
          ],
          "denue_col": "entidad",
          "erp_field": "direccion_estado"
        },
        {
          "key": "contacto_principal",
          "label_es": "Nombre Contacto Principal",
          "type": "text",
          "required": true,
          "fill": [
            "ia"
          ],
          "erp_field": "contacto_nombre"
        },
        {
          "key": "contacto_secundario",
          "label_es": "Nombre Segundo Contacto",
          "type": "text",
          "required": false,
          "fill": [
            "ia"
          ]
        },
        {
          "key": "telefono",
          "label_es": "Teléfono",
          "type": "phone",
          "required": true,
          "fill": [
            "denue",
            "ia"
          ],
          "denue_col": "telefono",
          "erp_field": "telefono"
        },
        {
          "key": "telefono_2",
          "label_es": "Segundo Teléfono",
          "type": "phone",
          "required": false,
          "fill": [
            "ia"
          ]
        },
        {
          "key": "correo",
          "label_es": "Correo electrónico",
          "type": "email",
          "required": false,
          "fill": [
            "denue",
            "ia"
          ],
          "denue_col": "correoelec",
          "erp_field": "email"
        }
      ]
    },
    {
      "key": "tamano_cliente",
      "label_es": "Tamaño del cliente",
      "fields": [
        {
          "key": "num_sucursales",
          "label_es": "# Sucursales / tiendas de venta",
          "type": "integer",
          "required": false,
          "fill": [
            "ia"
          ]
        },
        {
          "key": "num_almacenes",
          "label_es": "# Almacenes",
          "type": "integer",
          "required": false,
          "fill": [
            "ia"
          ]
        },
        {
          "key": "cantidad_personal",
          "label_es": "Cantidad de personal",
          "type": "integer",
          "required": false,
          "fill": [
            "ia",
            "denue"
          ],
          "denue_col": "per_ocu (rango, solo referencia)"
        },
        {
          "key": "num_vendedores",
          "label_es": "# Vendedores",
          "type": "integer",
          "required": false,
          "fill": [
            "ia"
          ]
        },
        {
          "key": "metodo_entrega",
          "label_es": "Método de entrega",
          "type": "multiselect",
          "required": false,
          "fill": [
            "ia"
          ],
          "options": [
            "Reparto propio (camioneta)",
            "Reparto en moto",
            "Paquetería",
            "El cliente recoge",
            "Otro"
          ]
        },
        {
          "key": "num_unidades_reparto",
          "label_es": "# Unidades de reparto",
          "type": "integer",
          "required": false,
          "fill": [
            "ia"
          ]
        },
        {
          "key": "entrega_domicilio",
          "label_es": "Entrega a domicilio",
          "type": "boolean",
          "required": false,
          "fill": [
            "ia"
          ]
        },
        {
          "key": "localidades_cobertura",
          "label_es": "Localidades de cobertura",
          "type": "text",
          "required": false,
          "fill": [
            "ia"
          ]
        }
      ]
    },
    {
      "key": "potencial",
      "label_es": "Potencial (mensual, MXN sin IVA)",
      "fields": [
        {
          "key": "venta_total_mensual",
          "label_es": "Venta total mensual",
          "type": "money",
          "required": false,
          "fill": [
            "ia"
          ]
        },
        {
          "key": "venta_suspension_mensual",
          "label_es": "Venta mensual de suspensión",
          "type": "money",
          "required": false,
          "fill": [
            "ia"
          ]
        },
        {
          "key": "compra_total_mensual",
          "label_es": "Compra total mensual",
          "type": "money",
          "required": false,
          "fill": [
            "ia"
          ]
        },
        {
          "key": "compra_suspension_mensual",
          "label_es": "Compra mensual de suspensión",
          "type": "money",
          "required": false,
          "fill": [
            "ia"
          ]
        }
      ]
    },
    {
      "key": "informacion_empresa",
      "label_es": "Información de la empresa",
      "fields": [
        {
          "key": "ofrece_credito",
          "label_es": "Ofrece crédito",
          "type": "boolean",
          "required": false,
          "fill": [
            "ia"
          ]
        },
        {
          "key": "anio_apertura",
          "label_es": "Año de Apertura",
          "type": "integer",
          "min": 1900,
          "max": 2100,
          "required": false,
          "fill": [
            "ia"
          ]
        },
        {
          "key": "horario_apertura_lv",
          "label_es": "Horario Apertura L-V",
          "type": "time",
          "required": false,
          "fill": [
            "ia"
          ]
        },
        {
          "key": "horario_cierre_lv",
          "label_es": "Horario Cierre L-V",
          "type": "time",
          "required": false,
          "fill": [
            "ia"
          ]
        },
        {
          "key": "horario_sabado",
          "label_es": "Horario Apertura y Cierre Sábado",
          "type": "text",
          "required": false,
          "fill": [
            "ia"
          ]
        },
        {
          "key": "num_tecnicos",
          "label_es": "Número de técnicos",
          "type": "integer",
          "required": false,
          "fill": [
            "ia"
          ]
        }
      ]
    },
    {
      "key": "facturacion",
      "label_es": "Información de Facturación",
      "note": "Normalmente no se menciona en la visita; se completa al dar de alta como cliente.",
      "fields": [
        {
          "key": "fact_nombre",
          "label_es": "Nombre",
          "type": "text",
          "required": false,
          "fill": [
            "manual"
          ]
        },
        {
          "key": "fact_apellido",
          "label_es": "Apellido",
          "type": "text",
          "required": false,
          "fill": [
            "manual"
          ]
        },
        {
          "key": "fact_calle",
          "label_es": "Calle",
          "type": "text",
          "required": false,
          "fill": [
            "manual"
          ]
        },
        {
          "key": "fact_colonia",
          "label_es": "Colonia",
          "type": "text",
          "required": false,
          "fill": [
            "manual"
          ]
        },
        {
          "key": "fact_ciudad",
          "label_es": "Ciudad",
          "type": "text",
          "required": false,
          "fill": [
            "manual"
          ]
        },
        {
          "key": "fact_estado",
          "label_es": "Estado",
          "type": "text",
          "required": false,
          "fill": [
            "manual"
          ]
        },
        {
          "key": "fact_cp",
          "label_es": "Código Postal",
          "type": "text",
          "pattern": "^[0-9]{5}$",
          "required": false,
          "fill": [
            "manual"
          ]
        },
        {
          "key": "fact_telefono",
          "label_es": "Teléfono",
          "type": "phone",
          "required": false,
          "fill": [
            "manual"
          ]
        },
        {
          "key": "fact_correo",
          "label_es": "Correo Electrónico",
          "type": "email",
          "required": false,
          "fill": [
            "manual"
          ]
        },
        {
          "key": "uso_cfdi",
          "label_es": "Uso de CFDI",
          "type": "text",
          "required": false,
          "fill": [
            "manual"
          ]
        },
        {
          "key": "rfc",
          "label_es": "RFC",
          "type": "text",
          "pattern": "^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$",
          "required": false,
          "fill": [
            "manual",
            "ia"
          ],
          "erp_field": "rfc"
        }
      ]
    },
    {
      "key": "tipo_taller",
      "label_es": "Tipo de Taller",
      "fields": [
        {
          "key": "tipo_taller",
          "label_es": "Tipo de Taller",
          "type": "multiselect",
          "required": true,
          "fill": [
            "ia",
            "denue"
          ],
          "denue_col": "codigo_act (sugerencia)",
          "options": [
            "Hojalatería y Pintura",
            "Refaccionaria",
            "Mayorista",
            "Flotilla",
            "Reparación General",
            "Aceite y Lubricación",
            "Transmisiones",
            "Rines/Llantas",
            "No Automotriz",
            "Lotes de Auto Usado",
            "Inspecciones de emisiones/Grúas"
          ]
        }
      ]
    },
    {
      "key": "servicios",
      "label_es": "Servicios",
      "fields": [
        {
          "key": "servicios",
          "label_es": "Servicios",
          "type": "multiselect",
          "required": false,
          "fill": [
            "ia"
          ],
          "options": [
            "Frenos",
            "Sistema de Escape",
            "Motores",
            "Aceite y Lubricación",
            "Transmisión",
            "Chasis y Suspensión",
            "Flotilla",
            "Importaciones",
            "Encendido y Carga",
            "Herramientas y Equipo",
            "Colisión y Pintura",
            "Calefacción y Refrigeración",
            "Desempeño",
            "Llantas",
            "Otro"
          ]
        },
        {
          "key": "servicios_otro",
          "label_es": "Otro (especificar)",
          "type": "text",
          "required": false,
          "fill": [
            "ia"
          ]
        }
      ]
    },
    {
      "key": "competencia",
      "label_es": "Información de la Competencia",
      "repeat": 3,
      "repeat_labels": [
        "Primera opción",
        "Segunda opción",
        "Tercera opción"
      ],
      "fields": [
        {
          "key": "marca",
          "label_es": "Marca",
          "type": "text",
          "required": false,
          "fill": [
            "ia"
          ]
        },
        {
          "key": "proveedor",
          "label_es": "Proveedor",
          "type": "text",
          "required": false,
          "fill": [
            "ia"
          ]
        },
        {
          "key": "producto_ejemplo",
          "label_es": "Ejemplo de producto",
          "type": "text",
          "required": false,
          "fill": [
            "ia"
          ]
        },
        {
          "key": "precio_compra",
          "label_es": "Precio de compra (MXN)",
          "type": "money",
          "required": false,
          "fill": [
            "ia"
          ]
        },
        {
          "key": "precio_venta_publico",
          "label_es": "Precio de venta al público (MXN)",
          "type": "money",
          "required": false,
          "fill": [
            "ia"
          ]
        }
      ]
    }
  ],
  "ai_output_contract": {
    "description": "Formato que debe devolver el análisis existente de la grabación. Solo llena lo que se dijo; lo no mencionado va en null. Nunca inventa.",
    "shape": {
      "resumen": "string (3-6 oraciones en español)",
      "campos": {
        "<field_key>": {
          "valor": "valor según type, o null",
          "evidencia": "frase breve de la conversación o null",
          "confianza": "alta | media | baja"
        }
      },
      "competencia": [
        {
          "marca": null,
          "proveedor": null,
          "producto_ejemplo": null,
          "precio_compra": null,
          "precio_venta_publico": null,
          "evidencia": null
        }
      ],
      "siguiente_paso": "string o null",
      "fecha_siguiente_paso": "YYYY-MM-DD o null",
      "etapa_sugerida": "2_contactado | 3_interesado | 4_cotizado | descartado | null"
    },
    "rules": [
      "Usar solo los field_key de este archivo con fill que incluya 'ia'.",
      "Opciones de multiselect: solo valores de 'options'.",
      "Montos en MXN como número, sin símbolo.",
      "Si el valor dicho contradice el dato DENUE precargado, devolver el valor dicho y marcar confianza 'media'."
    ]
  }
};

// 화면·저장용 평평한 항목 목록 — key = 섹션.항목 (경쟁사는 competencia.<n>.<항목>)
export function flattenForm(form = ALTA_FORM) {
  const out = [];
  for (const s of form.sections) {
    const reps = Number(s.repeat) > 1 ? Number(s.repeat) : 0;
    if (reps) {
      for (let i = 1; i <= reps; i++) {
        for (const f of s.fields) {
          out.push({ ...f, key: `${s.key}.${i}.${f.key}`, base: f.key, section: s.key, section_label: s.label_es,
            group: i, group_label: (s.repeat_labels && s.repeat_labels[i - 1]) || `#${i}` });
        }
      }
    } else {
      for (const f of s.fields) out.push({ ...f, key: `${s.key}.${f.key}`, base: f.key, section: s.key, section_label: s.label_es });
    }
  }
  return out;
}
// ── 방문 때 물어볼 질문(2026-11-26 디렉터 요청: 「고객별로 파악할 질문 항목과 답을 볼 수 있게」) ──
//   항목 key(base) → [한국어 질문, 스페인어 질문]. 화면은 사용자 언어로 보여 준다.
export const SECTION_KO = {
  datos_generales: '기본 정보', tamano_cliente: '고객 규모', potencial: '잠재성(월, IVA 제외)', informacion_empresa: '영업 정보',
  facturacion: '세금계산서 정보(고객 등록 때)', tipo_taller: '업종', servicios: '서비스', competencia: '경쟁사(현재 쓰는 브랜드)',
};
export const QUESTIONS = {
  nombre_cuenta: ['상호(가게 이름)는?', '¿Cuál es el nombre del negocio?'],
  calle: ['도로명', 'Calle'], numero: ['번지', 'Número'], colonia: ['Colonia', 'Colonia'], codigo_postal: ['우편번호', 'Código postal'],
  ciudad: ['도시', 'Ciudad'], estado: ['주', 'Estado'],
  contacto_principal: ['주 담당자(구매 결정하는 사람) 이름은?', '¿Quién decide las compras? (nombre)'],
  contacto_secundario: ['두 번째 연락할 사람은?', '¿Otra persona de contacto?'],
  telefono: ['연락처(WhatsApp)는?', '¿Teléfono / WhatsApp?'], telefono_2: ['다른 전화번호는?', '¿Otro teléfono?'],
  correo: ['이메일은?', '¿Correo electrónico?'],
  num_sucursales: ['매장(지점)이 몇 곳인가요?', '¿Cuántas sucursales o tiendas tienen?'],
  num_almacenes: ['창고가 몇 곳인가요?', '¿Cuántos almacenes tienen?'],
  cantidad_personal: ['직원은 몇 명인가요?', '¿Cuántas personas trabajan aquí?'],
  num_vendedores: ['영업사원은 몇 명인가요?', '¿Cuántos vendedores tienen?'],
  metodo_entrega: ['고객에게 어떻게 배송하나요? (자체 차량·오토바이·택배·고객 방문)', '¿Cómo entregan a sus clientes? (camioneta, moto, paquetería, el cliente recoge)'],
  num_unidades_reparto: ['배송 차량은 몇 대인가요?', '¿Cuántas unidades de reparto tienen?'],
  entrega_domicilio: ['배달해 주나요?', '¿Hacen entrega a domicilio?'],
  localidades_cobertura: ['어느 지역까지 파나요?', '¿A qué zonas o municipios venden?'],
  venta_total_mensual: ['한 달 매출은 대략 얼마인가요?', '¿Cuánto venden al mes, aproximadamente?'],
  venta_suspension_mensual: ['그중 서스펜션·조향 매출은?', '¿Cuánto de eso es suspensión y dirección?'],
  compra_total_mensual: ['한 달 부품 구매는 대략 얼마인가요?', '¿Cuánto compran de refacciones al mes?'],
  compra_suspension_mensual: ['그중 서스펜션·조향 구매는? (CTR가 가져올 수 있는 시장)', '¿Cuánto compran de suspensión y dirección al mes?'],
  ofrece_credito: ['고객에게 외상(신용)을 주나요?', '¿Dan crédito a sus clientes?'],
  anio_apertura: ['언제 문을 열었나요? (연도)', '¿En qué año abrieron?'],
  horario_apertura_lv: ['평일 여는 시간', 'Hora de apertura (L-V)'], horario_cierre_lv: ['평일 닫는 시간', 'Hora de cierre (L-V)'],
  horario_sabado: ['토요일 영업시간', 'Horario del sábado'],
  num_tecnicos: ['정비사(테크니션)는 몇 명인가요?', '¿Cuántos técnicos tienen?'],
  fact_nombre: ['청구 이름', 'Nombre (facturación)'], fact_apellido: ['청구 성', 'Apellido (facturación)'], fact_calle: ['청구 주소 도로', 'Calle (facturación)'],
  fact_colonia: ['청구 주소 Colonia', 'Colonia (facturación)'], fact_ciudad: ['청구 도시', 'Ciudad (facturación)'], fact_estado: ['청구 주', 'Estado (facturación)'],
  fact_cp: ['청구 우편번호', 'C.P. (facturación)'], fact_telefono: ['청구 전화', 'Teléfono (facturación)'], fact_correo: ['청구 이메일', 'Correo (facturación)'],
  uso_cfdi: ['CFDI 용도', 'Uso de CFDI'], rfc: ['RFC는?', '¿RFC?'],
  tipo_taller: ['어떤 업종인가요? (정비·부품점·도매 등)', '¿Qué tipo de negocio es? (taller, refaccionaria, mayorista…)'],
  servicios: ['어떤 서비스를 하나요?', '¿Qué servicios ofrecen?'], servicios_otro: ['기타 서비스', 'Otro servicio'],
  marca: ['지금 쓰는 서스펜션 브랜드는?', '¿Qué marca de suspensión usan ahora?'],
  proveedor: ['어디서 사나요? (공급처)', '¿A quién le compran? (proveedor)'],
  producto_ejemplo: ['대표 상품 예시는?', '¿Un producto de ejemplo?'],
  precio_compra: ['그 상품 구매가는?', '¿A cuánto lo compran?'],
  precio_venta_publico: ['그 상품 판매가는?', '¿A cuánto lo venden al público?'],
};
export const ALTA_FIELDS = flattenForm(ALTA_FORM).map((f) => ({ ...f, section_ko: SECTION_KO[f.section] || f.section_label,
  q_ko: (QUESTIONS[f.base] || [])[0] || f.label_es, q_es: (QUESTIONS[f.base] || [])[1] || f.label_es }));
export const ALTA_FIELD_MAP = Object.fromEntries(ALTA_FIELDS.map((f) => [f.key, f]));
