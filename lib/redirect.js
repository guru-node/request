'use strict'

const url = require('url')
const isUrl = /^https?:/

function Redirect (request) {
  this.request = request
  this.followRedirect = true
  this.followRedirects = true
  this.followAllRedirects = false
  this.followOriginalHttpMethod = false
  this.allowRedirect = function () { return true }
  this.maxRedirects = 10
  this.redirects = []
  this.redirectsFollowed = 0
  this.removeRefererHeader = false
}

Redirect.prototype.onRequest = function (options) {
  const self = this

  if (options.maxRedirects !== undefined) {
    self.maxRedirects = options.maxRedirects
  }
  if (typeof options.followRedirect === 'function') {
    self.allowRedirect = options.followRedirect
  }
  if (options.followRedirect !== undefined) {
    self.followRedirects = !!options.followRedirect
  }
  if (options.followAllRedirects !== undefined) {
    self.followAllRedirects = options.followAllRedirects
  }
  if (self.followRedirects || self.followAllRedirects) {
    self.redirects = self.redirects || []
  }
  if (options.removeRefererHeader !== undefined) {
    self.removeRefererHeader = options.removeRefererHeader
  }
  if (options.followOriginalHttpMethod !== undefined) {
    self.followOriginalHttpMethod = options.followOriginalHttpMethod
  }
}

Redirect.prototype.redirectTo = function (response) {
  const self = this
  const request = self.request

  let redirectTo = null
  if (response.statusCode >= 300 && response.statusCode < 400 && response.caseless.has('location')) {
    const location = response.caseless.get('location')
    request.debug('redirect', location)

    if (self.followAllRedirects) {
      redirectTo = location
    } else if (self.followRedirects) {
      switch (request.method) {
        case 'PATCH':
        case 'PUT':
        case 'POST':
        case 'DELETE':
          // Do not follow redirects
          break
        default:
          redirectTo = location
          break
      }
    }
  } else if (response.statusCode === 401) {
    const authHeader = request._auth.onResponse(response)
    if (authHeader) {
      request.setHeader('authorization', authHeader)
      redirectTo = request.uri
    }
  }
  return redirectTo
}

Redirect.prototype.onResponse = function (response) {
  const self = this
  const request = self.request

  let redirectTo = self.redirectTo(response)
  if (!redirectTo || !self.allowRedirect.call(request, response)) {
    return false
  }

  request.debug('redirect to', redirectTo)

  // ignore any potential response body.  it cannot possibly be useful
  // to us at this point.
  // response.resume should be defined, but check anyway before calling. Workaround for browserify.
  if (response.resume) {
    response.resume()
  }

  if (self.redirectsFollowed >= self.maxRedirects) {
    request.emit('error', new Error('Exceeded maxRedirects. Probably stuck in a redirect loop ' + request.uri.href))
    return false
  }
  self.redirectsFollowed += 1

  if (!isUrl.test(redirectTo)) {
    redirectTo = new url.URL(redirectTo, request.uri.href)
  }

  const uriPrev = request.uri
  request.uri = new url.URL(redirectTo)

  // handle the case where we change protocol from https to http or vice versa
  if (request.uri.protocol !== uriPrev.protocol) {
    delete request.agent
  }

  self.redirects.push({ statusCode: response.statusCode, redirectUri: redirectTo })

  if (self.followAllRedirects && request.method !== 'HEAD' &&
    response.statusCode !== 401 && response.statusCode !== 307) {
    request.method = self.followOriginalHttpMethod ? request.method : 'GET'
  }
  // request.method = 'GET' // Force all redirects to use GET || commented out fixes #215
  delete request.src
  delete request.req
  delete request._started
  if (response.statusCode !== 401 && response.statusCode !== 307) {
    // Remove parameters from the previous response, unless this is the second request
    // for a server that requires digest authentication.
    delete request.body
    delete request._form
    if (request.headers) {
      request.removeHeader('host')
      request.removeHeader('content-type')
      request.removeHeader('content-length')
      if (request.uri.hostname !== request.originalHost.split(':')[0]) {
        // Remove authorization if changing hostnames (but not if just
        // changing ports or protocols).  This matches the behavior of curl:
        // https://github.com/bagder/curl/blob/6beb0eee/lib/http.c#L710
        request.removeHeader('authorization')
      }
    }
  }

  if (!self.removeRefererHeader) {
    request.setHeader('referer', uriPrev.href)
  }

  request.emit('redirect')

  request.init()

  return true
}

exports.Redirect = Redirect
