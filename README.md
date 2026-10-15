# Signatura Backup

Descarga a su computadora una copia de **todos los documentos** de su espacio
de trabajo de Signatura, con sus certificados de auditoría, ordenados por
fecha. Sirve para guardar un respaldo completo, por ejemplo al cerrar la
cuenta.

No necesita conocimientos técnicos: son cinco pasos. Las instrucciones son
para Windows; al final de cada paso hay una nota para Mac.

## Antes de empezar

Necesita tres cosas:

1. **Una clave de API de Signatura.** La crea un administrador de su cuenta
   desde el panel de Signatura. Es un texto largo; téngalo a mano para
   pegarlo cuando el programa lo pida.
2. **Espacio en el disco.** Calcule unos 500 KB por documento como referencia
   (10.000 documentos, unos 5 GB).
3. **Tiempo.** El programa descarga de a poco para no saturar el servicio:
   unos 100 documentos por minuto. Para 10.000 documentos tardará unas
   5 horas. Puede interrumpirlo y continuarlo más tarde sin perder nada.

## Paso 1. Instalar Node.js

Node.js es el programa que ejecuta esta herramienta.

1. Entre en <https://nodejs.org>.
2. Pulse el botón de descarga de la versión **LTS** para Windows. Se baja un
   instalador `.msi`.
3. Ábralo y pulse **Siguiente** hasta el final, sin cambiar nada.
4. Para comprobarlo, pulse la tecla **Windows**, escriba `powershell`, abra
   **Windows PowerShell** y escriba:

   ```
   node --version
   ```

   Debe responder `v22` o un número mayor. Si dice que no reconoce `node`,
   cierre PowerShell, vuelva a abrirlo y pruebe de nuevo.

> **Mac:** descargue el instalador `.pkg` LTS de la misma página y
> compruébelo desde la aplicación **Terminal**.

## Paso 2. Descargar el programa

1. En esta página de GitHub, pulse el botón verde **Code** y luego
   **Download ZIP**.
2. En la carpeta Descargas, haga clic derecho sobre el archivo ZIP y elija
   **Extraer todo...**. Queda una carpeta llamada `signatura-backup-cli-main`.
3. Muévala a un lugar cómodo, por ejemplo el Escritorio.

## Paso 3. Abrir PowerShell en esa carpeta

1. Abra la carpeta `signatura-backup-cli-main` en el Explorador de archivos.
   Debe ver dentro las carpetas `bin` y `src`.
2. Haga clic en la **barra de direcciones** (arriba, donde se muestra la ruta
   de la carpeta), escriba `powershell` y pulse Enter.

Se abre una ventana de PowerShell ya ubicada en la carpeta.

> **Mac:** abra **Terminal**, escriba `cd ` (con un espacio al final),
> arrastre la carpeta desde el Finder hasta la ventana y pulse Enter.

## Paso 4. Ejecutar el programa

Escriba este comando y pulse Enter:

```
node .\bin\signatura-backup.js bak
```

`bak` es el nombre de la carpeta donde se guardará todo; se crea dentro de la
carpeta del programa. Si prefiere otro lugar, escriba la ruta completa en su
lugar, por ejemplo:

```
node .\bin\signatura-backup.js "D:\Respaldo Signatura"
```

Las comillas son necesarias cuando la ruta tiene espacios.

> **Mac:** el comando es `node bin/signatura-backup.js bak` (barra normal en
> lugar de `.\`).

## Paso 5. Pegar la clave y confirmar

1. El programa pide `Pegue su clave de API:`. Pegue la clave y pulse Enter.
   En PowerShell se pega con **clic derecho** o con `Ctrl+V`.
   **No se ve nada mientras la pega**; es normal, es para que no quede a la
   vista.
2. El programa verifica la clave y muestra cuántos documentos encontró, la
   carpeta de destino y el tiempo estimado.
3. Pregunta `¿Iniciar la copia? [s/N]`. Escriba `s` y pulse Enter.

Listo. Deje la computadora encendida y conectada a la corriente, y evite que
entre en suspensión (en Windows: **Configuración > Sistema > Energía**,
ponga **Nunca** en suspender mientras dure la copia). Una línea en la ventana
va mostrando el avance:

```
Descargando archivos · 2340 de 10000 archivos · 41% · restante 2 h 50 min · 1,2 GB
```

Si aparece `Reconectando...`, se cortó internet; el programa espera y sigue
solo cuando vuelve.

### Si necesita interrumpir

Pulse `Ctrl+C` o cierre la ventana. No se pierde nada. Para continuar,
repita los pasos 3, 4 y 5 con la **misma carpeta**. El programa avisa
`Ya existe una copia en esta carpeta` y sigue desde donde quedó.

## Cuando termina

El programa muestra `Copia finalizada` y cuántos archivos descargó. En la
carpeta de destino encontrará:

```
bak\
  indice.csv              ← lista de todos los documentos; ábralo con Excel
  2024\
    2024-03\
      2024-03-11_Contrato-ACME_a1b2c3\
        Contrato ACME.pdf
        Contrato ACME [certificado].pdf
```

- Cada documento tiene su carpeta, con el año, el mes, la fecha, el título y
  los archivos PDF.
- El certificado de auditoría acompaña a cada PDF de un documento completado.
  Los documentos pendientes, cancelados o en borrador no tienen certificado.
- `indice.csv` tiene una fila por archivo: fecha, título, estado, firmantes,
  carpeta y nombre de archivo. Se abre con doble clic en Excel, con las
  columnas ya separadas.

**Importante:** cuando termine, pida al administrador que **desactive la
clave de API** desde el panel de Signatura. Ya no hace falta y es mejor que
no quede activa.

## Si algo sale mal

| Mensaje | Qué hacer |
|---|---|
| `"node" no se reconoce como un comando` | Node.js no está instalado o PowerShell se abrió antes de instalarlo. Repita el Paso 1 y abra una ventana nueva. |
| `La clave no fue aceptada` | La clave está mal copiada o fue desactivada. Pida una nueva al administrador. |
| `No se pudo conectar con Signatura` | Revise la conexión a internet y vuelva a ejecutar el comando. |
| `Esta carpeta contiene una copia de otro espacio de trabajo` | Esa carpeta ya se usó con otra clave. Elija otra carpeta de destino. |
| `No hay espacio suficiente en el disco` | Libere espacio o elija un disco con más lugar, y repita el comando con la misma carpeta para continuar. |
| `N errores registrados` al terminar | Algunos archivos no se pudieron descargar. Repita el comando agregando `--retry-failed` al final. El detalle está en `bak\.signatura-backup\errores.csv`. |

Si el problema persiste, envíe a soporte el archivo
`bak\.signatura-backup\registro.log`. No contiene la clave de API. La carpeta
`.signatura-backup` está oculta; para verla, active **Ver > Mostrar >
Elementos ocultos** en el Explorador.

## Opciones avanzadas

Para quien quiera automatizarlo. Ninguna es necesaria en el uso normal.

```
node .\bin\signatura-backup.js [opciones] <carpeta-de-destino>
```

| Opción | Efecto |
|---|---|
| `--yes` | No pregunta `¿Iniciar la copia?`. |
| `--retry-failed` | Vuelve a intentar los archivos que fallaron en la copia anterior. |
| `--verbose` | Muestra el registro completo en la ventana. |
| `--concurrency <n>` | Descargas en paralelo (predeterminado: 4). |
| `--help` | Muestra la ayuda. |

La clave también puede pasarse en la variable de entorno `SIGNATURA_API_KEY`,
útil para ejecuciones sin intervención:

```
$env:SIGNATURA_API_KEY = "..."          # PowerShell
node .\bin\signatura-backup.js --yes "D:\Respaldo Signatura"
```

Códigos de salida: `0` copia completa, `1` copia interrumpida o cancelada,
`2` argumentos inválidos, `130` detenida con Ctrl+C.

---

Copyright 2026 Consentio Inc.
