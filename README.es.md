# opencode-free-router

[![ci](https://github.com/ERKPRIME/openrouter-free/actions/workflows/ci.yml/badge.svg)](https://github.com/ERKPRIME/openrouter-free/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/openrouter-free.svg)](https://www.npmjs.com/package/openrouter-free)
[![Coverage Status](https://coveralls.io/repos/github/ERKPRIME/openrouter-free/badge.svg?branch=master)](https://coveralls.io/github/ERKPRIME/openrouter-free?branch=master)

Español: este archivo. Inglés: [README.md](README.md).

Un plugin de [opencode](https://opencode.ai) que siempre usa el **mejor modelo gratuito disponible en este momento**. Eliges `free/auto` y el plugin hace el resto:

- **Clasificado, no aleatorio.** Los modelos gratuitos se puntúan con [LMArena](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset) y [Artificial Analysis](https://artificialanalysis.ai).
- **Persistente.** Una sesión conserva su modelo; las sesiones nuevas obtienen los modelos más recientes o mejores.
- **Con failover.** Los modelos con cuota agotada, límite de peticiones o retirados entran en cooldown y el turno continúa con el siguiente modelo.
- **Solo gratuitos.** Allowlist explícita; nunca se usan planes de suscripción con precio 0.

## Requisitos

- **opencode 2** (`opencode --version` muestra 2.x)
- **Node.js 22.18+** (o Bun en POSIX)

## Instalación (npm)

La forma recomendada de instalar es mediante npm:

```sh
npm install -g openrouter-free
openrouter-free
```

Después de instalar, ejecuta `openrouter-free` (o `opencode-free`) para comenzar a usarlo. Tu comando `opencode` normal no se modifica.

## Otras formas de instalar

Si prefieres instalar desde el código (por ejemplo para elegir la carpeta de instalación, o en Windows sin npm):

```sh
git clone https://github.com/ERKPRIME/openrouter-free.git
cd openrouter-free

# macOS / Linux / WSL / Git Bash:
./scripts/install.sh

# Símbolo del sistema (Windows):
install.cmd

# PowerShell (Windows):
.\install.ps1
```

Opciones: `--bb` registra también un agente ACP "Free (auto)" en bb; `--dir PATH` elige la carpeta de instalación; `--no-rank` omite la primera clasificación.

Volver a ejecutar el instalador actualiza en el lugar y nunca sobrescribe tu configuración, claves ni estado.

## Uso

```sh
opencode-free                 # TUI con free/auto
opencode-free run "..."       # una sola ejecución (entrecomilla el mensaje)
opencode-free acp             # agente ACP (bb, Zed, JetBrains…)
opencode-free doctor          # versiones, rutas, qué falta
opencode-free rank --status   # clasificación, cooldowns, modelo por sesión
```

`opencode-free` es `opencode` normal con la configuración del free-router superpuesta mediante `OPENCODE_CONFIG`.

## Modelos gratuitos

Sin claves obtienes los modelos gratuitos de OpenCode Zen. Cada clave que añades amplía el pool:

| Proveedor | Variable de entorno |
|---|---|
| OpenRouter | `OPENROUTER_API_KEY` |
| NVIDIA | `NVIDIA_API_KEY` |
| Z.AI / Zhipu | `ZHIPU_API_KEY` |
| ModelScope | `MODELSCOPE_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| Google AI Studio | `GOOGLE_GENERATIVE_AI_API_KEY` |

Las claves de `opencode auth login` o de tu entorno funcionan automáticamente. Si no, ponlas en `~/.config/opencode/free-router/providers.env` (Windows: la carpeta de instalación).

Usa cuentas de plan gratuito: los niveles gratuitos de Groq, Cerebras, Google y Mistral pueden generar cargos si la facturación está activada.

## Configuración

Todo es opcional. `config.json` combina clave por clave con los valores predeterminados. `pins.json` fija, prohíbe y asigna alias a modelos:

```json
{
  "pin":   ["opencode/space-bunny-free"],
  "ban":   ["openrouter/liquid/lfm-2.5-2.6b:free"],
  "alias": { "opencode/some-model-free": "nombre-en-la-clasificacion" }
}
```

Ejecuta `opencode-free rank --status` después de editar.

## Actualización y desinstalación

```sh
npm update -g openrouter-free
npm uninstall -g openrouter-free
```

Los datos (`config.json`, claves, `ranking.json`, estado) se conservan a menos que los borres manualmente.

## Licencia

[BSD-2-Clause](LICENSE)

Las puntuaciones de los modelos provienen de LMArena y Artificial Analysis; sin afiliación con ninguno de los dos, ni con opencode.
