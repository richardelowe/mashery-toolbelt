const fetch = require('node-fetch')
const { URL } = require('url')
const UrlPattern = require('url-pattern')
const apiMethods = require('./methods')
const { makeFieldsParam } = require('./fields')
const { AuthenticationError, RequestError } = require('./errors')
const errorMessages = require('./error_messages')
const throttle = require('./throttle')

function makePath ({ pattern, args }) {
  const pathArgs = {}

  pattern.names.forEach((argName, i) => {
    const val = args[i]
    const valType = typeof val

    if (!['number', 'string'].includes(valType)) {
      const errorMessage = errorMessages.invalid_url_part({
        argName,
        pattern,
        val,
        valType
      })
      throw new RequestError('invalid_url_part', errorMessage)
    }

    pathArgs[argName] = val
  })

  return pattern.stringify(pathArgs)
}

function waitForQps (client, time) {
  if (!client.__qpsWaiting) {
    client.__qpsWaiting = new Promise(resolve => {
      setTimeout(() => {
        client.__qpsWaiting = null
        resolve()
      }, time)
    })
  }

  return client.__qpsWaiting
}

function makeRequestHeaders (credentials) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${credentials.accessToken}`,
    'Content-Type': 'application/json'
  }
}

function callClientRequestWithAuth (client, url, options) {
  // a) authenticate and repeat
  if (!client.isAuthenticated()) {
    return client
      .authenticate()
      .then(() => callClientRequestWithAuth(client, url, options))
  }

  // b) refresh token and repeat
  if (client.isTokenExpired()) {
    return client
      .refreshToken()
      .then(() => callClientRequestWithAuth(client, url, options))
  }

  const headers = makeRequestHeaders(client.credentials)
  const optionsWithHeaders = Object.assign({}, options, { headers })

  return fetch(url, optionsWithHeaders)
}

function callClientRequest (client, url, options) {
  const request = callClientRequestWithAuth(client, url, options)

  return request.then(response => {
    const headers = response.headers
    const errorCode = headers.get('x-mashery-error-code')

    // a) Catch throttling limit
    if (errorCode === 'ERR_403_DEVELOPER_OVER_QPS') {
      const retryIn = Number(headers.get('retry-after')) * 1000
      return waitForQps(client, retryIn).then(() =>
        callClientRequest(client, url, options)
      )
    }

    // b) Catch unauthorized access (wrong key, secret or token)
    if (errorCode === 'ERR_403_DEVELOPER_INACTIVE') {
      const error = new AuthenticationError('developer_inactive')
      client.handleAuthenticationError(error)
      throw error
    }

    // c) Catch other errors
    if (errorCode) {
      throw new RequestError(errorCode, headers.get('x-error-detail-header'))
    }

    const contentType = headers.get('content-type')
    const isJson = contentType && contentType.includes('application/json')
    const payloadPromise = isJson ? response.json() : response.text()

    return payloadPromise.then(payload => {
      if (response.status >= 200 && response.status < 300) {
        return payload
      }

      const errorPayload = isJson ? JSON.stringify(payload) : payload
      const errorMessage = errorMessages.request_error(
        options.method || 'GET',
        url,
        response.status,
        errorPayload
      )

      throw new RequestError(`request_error`, errorMessage)
    })
  })
}

function registerClientMethod (client, name, pathPattern, method, fields) {
  const pattern = new UrlPattern(pathPattern)
  method = method.toUpperCase()

  client[name] = function (...args) {
    const path = makePath({ pattern, args })
    const url = new URL(
      `${client.options.resourceEndpoint}${path}`,
      client.options.host
    )
    const data =
      args.length > pattern.names.length ? args[pattern.names.length] : null

    const options = {}

    if (method === 'GET') {
      // Set query params
      if (data !== null) {
        Object.keys(data).forEach(key => {
          const value =
            key === 'fields'
              ? makeFieldsParam(name, fields, data[key])
              : data[key]

          if (value !== null && value !== undefined) {
            url.searchParams.set(key, value)
          }
        })
      }
    } else {
      options.method = method
      // TODO: validate data againts fields
      options.body = data && JSON.stringify(data)
    }

    return throttle(client, () =>
      callClientRequest(client, url.toString(), options)
    )
  }
}

function registerClientMethods (client) {
  apiMethods.forEach(methodDefinition => {
    registerClientMethod(client, ...methodDefinition)
  })
}

module.exports = {
  registerClientMethods
}
