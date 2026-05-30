'use strict'

const APIError = require('./APIError')
const GatewayError = require('./lib/GatewayError')
const { isDuplicateKeyError } = require('./lib/helpers')

module.exports = {
  APIError,
  GatewayError,
  isDuplicateKeyError
}
