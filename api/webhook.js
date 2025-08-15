// api/webhook.js
export default async function handler(req, res) {
  try {
    return res.status(200).send('OK');
  } catch (e) {
    return res.status(200).send('OK');
  }
}
