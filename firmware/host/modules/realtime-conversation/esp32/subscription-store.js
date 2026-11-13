import TextDecoder from 'text/decoder'

const available = native('xs_subscription_store_available')
const read = native('xs_subscription_store_read')
const write = native('xs_subscription_store_write')
const clear = native('xs_subscription_store_clear')
const decoder = new TextDecoder('utf-8', { fatal: true })

export default {
  available,
  read() {
    const bytes = read()
    return bytes === undefined ? undefined : JSON.parse(decoder.decode(bytes))
  },
  write(record) {
    write(ArrayBuffer.fromString(JSON.stringify(record)))
  },
  clear,
}
