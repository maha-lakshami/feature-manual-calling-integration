import plivo from "plivo";

const authId = process.env.PLIVO_AUTH_ID;
const authToken = process.env.PLIVO_AUTH_TOKEN;

if (!authId || !authToken) {
  throw new Error("Missing Plivo credentials");
}

export const plivoClient = new plivo.Client(authId, authToken);