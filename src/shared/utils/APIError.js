'use strict'

class APIError extends Error {
  constructor (message, statusCode = 500) {
    super(message)
    this.name = 'APIError'
    this.statusCode = statusCode
    this.sMessageName = message
  }
}

module.exports = APIError
