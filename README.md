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

## Traffic simulation

With the service running locally, use the simulator to add a small amount of
sample traffic to Grafana. It defaults to one request every five seconds for
one minute, and stops automatically. Available modes are `mixed`, `success`,
`database`, `notFound`, `unauthorized`, `badJson`, and `authenticated`.

```sh
node scripts/traffic-simulator.js mixed
```

The mixed mode includes a not-found request, an unauthorized request, and
malformed JSON to exercise error logging. It also includes an authenticated
database request when `JWT_PIZZA_EMAIL` and `JWT_PIZZA_PASSWORD` are set. The
simulator only reads application data. To change the target or pacing, set
`PIZZA_SERVICE_URL`, `TRAFFIC_INTERVAL_SECONDS`, or
`TRAFFIC_DURATION_SECONDS`.

## Development notes

Install the required packages.

```sh
npm install express jsonwebtoken mysql2 bcrypt
```

Nodemon is assumed to be installed globally so that you can have hot reloading when debugging.

```sh
npm -g install nodemon
```
