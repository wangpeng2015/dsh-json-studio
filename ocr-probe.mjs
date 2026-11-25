import { readFileSync } from 'node:fs'
import { createOcrEngine } from './src/ocr.js'

const engine = createOcrEngine({ langDir: 'E:/selfwork/json-studio/assets/lang', defaultLangs: 'eng' })
console.log('describe', engine.describe())
const base64 = readFileSync('E:/selfwork/json-studio/test/fixtures/ocr/json-clean-900x420.png').toString('base64')
const started = Date.now()
const first = await engine.recognize({ base64, langs: 'eng' })
console.log('first ms', Date.now() - started, 'conf', first.confidence, 'dims', first.width, first.height)
console.log(first.text)
const second = await engine.recognize({ base64, langs: 'eng' })
console.log('second ms', Date.now() - started, 'len', second.text.length)
const chinese = readFileSync('E:/selfwork/json-studio/test/fixtures/ocr/json-chinese.png').toString('base64')
const mixed = await engine.recognize({ base64: chinese, langs: 'chi_sim+eng' })
console.log('mixed ms', mixed.ms, 'conf', mixed.confidence)
console.log(mixed.text)
await engine.dispose()
console.log('disposed')
