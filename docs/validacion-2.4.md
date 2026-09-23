# Validación contra Meta y R2 reales (bloque 2.4)

Todo lo anterior se probó contra simuladores: un servidor local que imita la
Graph API y un MinIO que imita R2. Eso cubre la lógica, pero no la
configuración de las cuentas reales, que es donde fallan la mayoría de los
despliegues.

Este documento es el procedimiento para validar contra Meta y Cloudflare R2 de
verdad. Dos comandos hacen casi todo el trabajo:

```bash
pnpm --filter @nexo/storage verify        # R2
pnpm --filter @nexo/api verify:whatsapp   # Meta
```

Ambos se ejecutan en cada CI contra el simulador y contra MinIO, así que si
fallan contra los servicios reales, lo que falla es la configuración, no la
herramienta.

---

## 1 · Preparación

| Necesitas                                      | Cómo                                                  |
| ---------------------------------------------- | ----------------------------------------------------- |
| Bucket y token de R2                           | `docs/despliegue-r2.md`, secciones 1 y 2              |
| CORS del bucket                                | Misma guía, sección 4, con el origen exacto de la web |
| App de Meta con número de pruebas              | Ya la tienes                                          |
| Una **URL pública con HTTPS** para el webhook  | Ver más abajo                                         |
| Un teléfono con WhatsApp para hacer de cliente | Tu propio móvil sirve                                 |

### La URL pública

Meta sólo entrega webhooks a `https` con certificado válido. Para la
validación basta un túnel:

```bash
cloudflared tunnel --url http://localhost:4000
```

Devuelve una URL como `https://algo-aleatorio.trycloudflare.com`. Se pone en
el entorno de la API **y se reinicia**, porque es lo que se muestra al conectar
un canal:

```bash
API_PUBLIC_URL=https://algo-aleatorio.trycloudflare.com
```

Con el dominio definitivo detrás de Nginx (Fase 7), esta variable será ese
dominio y el túnel sobra.

---

## 2 · Validar R2

```bash
pnpm --filter @nexo/storage verify
```

Comprueba, en este orden: acceso al bucket, escritura, lectura, listado, URL
firmada de descarga (con el tipo y el nombre que fija el servidor), que
manipularla la invalida, que **sin firma no se sirve nada**, URL firmada de
subida, que subir otro tamaño se rechaza, CORS para subir y para descargar
desde el origen de la web, y que una URL caducada deja de servir.

Escribe y borra un único objeto de prueba bajo
`tenants/00000000-0000-7000-8000-000000000000/`, que no es de ninguna empresa.
Nunca toca datos de clientes ni imprime credenciales.

| Si falla                                         | Qué mirar                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `el bucket existe y las credenciales dan acceso` | Nombre del bucket, y que el token sea _Object Read & Write_ sobre ese bucket            |
| `sin firma no se sirve nada`                     | **Grave**: el bucket es público. Quita el dominio público y `r2.dev`                    |
| `el bucket permite subir desde …`                | La política CORS: el origen tiene que coincidir exactamente, con su esquema y su puerto |
| `una URL caducada deja de servir`                | Reloj del servidor desincronizado                                                       |

---

## 3 · Validar Meta

1. Conecta el número en **Ajustes → Canales** con los datos de tu app.
2. Copia la URL del webhook y el token de verificación que muestra la ficha.
3. En el panel de Meta, en _WhatsApp → Configuración → Webhook_, pega ambos y
   **suscríbete al campo `messages`**.
4. Ejecuta:

```bash
pnpm --filter @nexo/api verify:whatsapp
```

Comprueba: que la versión de la Graph API responde y el token da acceso al
número, que el número coincide con el que guardó Nexo, que tiene nombre
verificado, que el token también alcanza la cuenta de WhatsApp Business (hace
falta para las plantillas), que la app está suscrita a esa cuenta y que la URL
del webhook es pública y contesta la verificación.

| Si falla                                          | Qué mirar                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `la versión … responde` con «Unsupported version» | Meta retiró esa versión: sube `META_GRAPH_VERSION` a una vigente |
| `da acceso al número` con código 190              | El token caducó o no es de un usuario del sistema                |
| `cuenta de WhatsApp Business` con 400             | El token no tiene permiso sobre la cuenta, sólo sobre el número  |
| `suscrita a la cuenta` con 0 apps                 | Falta suscribir la app en el panel de Meta                       |
| `pública y con https`                             | `API_PUBLIC_URL` sigue apuntando a `localhost`                   |
| `contesta la verificación`                        | El túnel está caído, o la API no está levantada                  |

Para un envío real (cuesta dinero y abre una conversación de 24 h):

```bash
pnpm --filter @nexo/api verify:whatsapp -- --enviar 593990000000
```

Si Meta responde con el código 131047, es lo esperado: ese número tiene que
escribirte primero, o hay que mandarle una plantilla.

---

## 4 · Prueba de extremo a extremo, a mano

Con los dos verificadores en verde, queda comprobar el producto con un
teléfono real. Del móvil a la bandeja y de vuelta:

1. [ ] Escribe **desde tu móvil** al número del negocio. La conversación
       aparece en la bandeja en segundos, sin recargar.
2. [ ] El contacto se crea con tu número y tu nombre de WhatsApp.
3. [ ] Responde desde la bandeja. Te llega al móvil.
4. [ ] El mensaje pasa a «entregado» y, al abrirlo en el móvil, a «leído».
5. [ ] Envía una **foto** desde el móvil: se ve en el hilo.
6. [ ] Envía un **PDF** y una **nota de voz**: se descargan y se reproducen.
7. [ ] Adjunta una imagen **desde la bandeja**: te llega al móvil.
8. [ ] Adjunta un PDF con pie de foto: llega con su nombre.
9. [ ] Sincroniza las plantillas en Ajustes → Canales: aparecen las de tu
       cuenta con su estado.
10. [ ] Fuerza la ventana cerrada (en la base de datos, `window_expires_at` en
        el pasado) y envía una **plantilla**: te llega al móvil.
11. [ ] Desconecta y vuelve a conectar el número: las conversaciones siguen.
12. [ ] Revisa los registros: sin errores de Prisma, sin URLs de Meta ni
        tokens.

---

## 5 · Qué hacer si algo va mal en medio de la prueba

- **No llega nada a la bandeja.** Mira los registros de la API: si no hay
  peticiones al webhook, el problema está en Meta (suscripción o URL). Si hay
  peticiones con 401, la clave secreta de la app no coincide.
- **Llega pero no aparece.** Mira el worker: `Evento de WhatsApp ignorado` dice
  el motivo, casi siempre que el número del evento no es el del canal.
- **Los archivos quedan «guardando…».** El worker lo dice: dominio no
  permitido, SHA-256 distinto o tipo no admitido.
- **Un envío queda «no enviado»** con el motivo de Meta en el propio mensaje.

---

## 6 · Antes de abrir a clientes

Esto no lo cubren los verificadores y hay que resolverlo aparte:

- [ ] Dominio propio con HTTPS y Nginx delante (Fase 7), en lugar del túnel.
- [ ] Número de producción con nombre verificado y su límite de mensajería
      revisado en el panel de Meta.
- [ ] Copias de seguridad de la base de datos y decisión sobre versionado del
      bucket.
- [ ] Vigilancia de las colas de fallidos y alertas.
- [ ] Decisión sobre antivirus de archivos.
