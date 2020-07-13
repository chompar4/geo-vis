const path = require('path')

const express = require('express')

const PORT = 5000
const app = express()

app.use(express.static(__dirname))

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'))
})

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Running at http://localhost:${PORT}`)
})
