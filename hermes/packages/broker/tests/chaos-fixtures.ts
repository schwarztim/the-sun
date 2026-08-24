export function teams401ErrorCode911Fixture() {
  return {
    status: 401,
    statusText: 'Unauthorized',
    headers: {
      authorization: 'Bearer teams-secret-access-token',
      cookie: 'skypetoken_asm=secret-cookie-value; sessionid=secret-session',
      'x-skypetoken': 'secret-skype-token-header',
    },
    body: {
      errorCode: 911,
      message: 'Unauthorized: Skype token rejected for chat messages',
      chatMessage: {
        body: { content: 'super secret Teams message body' },
      },
    },
  };
}

export function stashSessionNotFoundFixture() {
  return {
    jsonrpc: '2.0',
    id: 42,
    error: {
      code: -32001,
      message: 'Session not found',
    },
  };
}

export function serviceNow401Fixture() {
  return {
    status: 401,
    statusText: 'Unauthorized',
    body: {
      error: {
        code: 'api_unauthorized',
        message: 'ServiceNow API token was rejected',
      },
    },
    headers: {
      authorization: 'Bearer servicenow-secret-token',
      cookie: 'glide_user_session=secret-cookie',
    },
  };
}

export function toolHivePortConflictFixture() {
  return {
    error: new Error('EADDRINUSE: address already in use 127.0.0.1:9876'),
    listener: { port: 9876, pid: 12345 },
  };
}
