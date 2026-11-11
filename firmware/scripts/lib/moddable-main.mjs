import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Materializes the SDK entry point in this build's generated IDF project. */
export function prepareModdableMain({ moddableDirectory, mainDirectory, realtime }) {
  if (!moddableDirectory) {
    if (realtime) throw new Error('MODDABLE is required to configure the CoreS3 XS task')
    return
  }
  const sourcePath = path.join(moddableDirectory, 'build/devices/esp32/lib/main/main.c')
  let source = readFileSync(sourcePath, 'utf8')
  if (realtime) {
    // Pin before the first FPU use can bind an unpinned XS task to the codec core.
    const calls = [...source.matchAll(/^([ \t]*)xTaskCreate\((loop_task,\s*"main",[^\n]*)\);$/gm)]
    if (calls.length !== 1) throw new Error(`Unsupported Moddable main task entry point: ${sourcePath}`)
    const [original, indent, args] = calls[0]
    source = source.replace(original, `${indent}xTaskCreatePinnedToCore(${args}, 0);`)
  }
  mkdirSync(mainDirectory, { recursive: true })
  const destination = path.join(mainDirectory, 'main.c')
  // Make also depends on the parent directory. Refresh the file after sibling
  // generation so its copy rule cannot replace this build's configured source.
  writeFileSync(destination, source)
  return destination
}
