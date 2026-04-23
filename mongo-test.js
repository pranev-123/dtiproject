const { MongoClient, ServerApiVersion } = require('mongodb');

const uri = 'mongodb+srv://pranevkarthicks_db_user:QCl8sCBEOyov92M8@dti.9dwe2ax.mongodb.net/?retryWrites=true&w=majority&appName=DTI';

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    console.log('Pinged your deployment. You successfully connected to MongoDB!');
  } finally {
    await client.close();
  }
}

run().catch((err) => {
  console.error('Mongo test failed:', err && err.message ? err.message : err);
  process.exitCode = 1;
});
