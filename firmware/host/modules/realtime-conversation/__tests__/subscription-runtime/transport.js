export default class Transport {
  constructor() {
    throw new Error('A missing grant must fail before native transport creation')
  }
}
