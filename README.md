# 🍕 jwt-pizza-service

![Coverage badge](https://pizza-factory.cs329.click/api/badge/tewbryn/jwtpizzaservicecoverage)

Backend service for making JWT pizzas. This service tracks users and franchises and orders pizzas. All order requests are passed to the JWT Pizza Factory where the pizzas are made.

JWTs are used for authentication objects.

## Deployment

In order for the server to work correctly it must be configured by providing a `config.js` file.

```js
module.exports =  {
    // Your JWT secret can be any random string you would like. It just needs to be secret.
   jwtSecret: 'yourjwtsecrethere',
   db: {
   connection: {
      host: '127.0.0.1',
      user: 'root',
      password: 'yourpasswordhere',
      database: 'pizza',
      connectTimeout: 60000,
   },
   listPerPage: 10,
   },
   factory: {
   url: 'https://pizza-factory.cs329.click',
   apiKey: 'yourapikeyhere',
   },
};
```

To send application logs to Grafana Loki, configure the `logging` object in
`src/config.js` with `source`, `accountId`, `endpointUrl`, and `apiKey`. The CI
workflow fills these from `LOGGING_ACCOUNT_ID`, `LOGGING_ENDPOINT_URL`, and
`LOGGING_API_KEY`. Log delivery is disabled if any required logging setting is
missing.

## Endpoints

You can get the documentation for all endpoints by making the following request.

```sh
curl localhost:3000/api/docs
```

## Development notes

Install the required packages.

```sh
npm install express jsonwebtoken mysql2 bcrypt
```

Nodemon is assumed to be installed globally so that you can have hot reloading when debugging.

```sh
npm -g install nodemon
```
