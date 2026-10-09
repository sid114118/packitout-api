const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Clean up the URI (removing the < and > around the password if the user included them)
const rawUri = "mongodb+srv://packitout_db:<tXfFsH3LaEWF4YED>@cluster0.bceowku.mongodb.net/?appName=Cluster0";
const uri = rawUri.replace('<', '').replace('>', '');

// We'll save the backup to a folder on the Desktop named "PackItOut_Backup_YYYY-MM-DD"
const dateStr = new Date().toISOString().split('T')[0];
const backupDir = path.join(os.homedir(), 'Desktop', `PackItOut_Backup_${dateStr}`);

async function backup() {
  console.log("⏳ Connecting to MongoDB Atlas cluster...");
  const client = new MongoClient(uri);
  
  try {
    await client.connect();
    // Use the default database attached to this cluster connection
    const db = client.db(); 
    console.log(`✅ Connected successfully to database: ${db.databaseName}`);
    
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const collections = await db.listCollections().toArray();
    console.log(`📂 Found ${collections.length} collections. Downloading data...`);

    let totalDocs = 0;

    for (const colInfo of collections) {
      const collectionName = colInfo.name;
      const collection = db.collection(collectionName);
      const docs = await collection.find({}).toArray();
      
      const filePath = path.join(backupDir, `${collectionName}.json`);
      fs.writeFileSync(filePath, JSON.stringify(docs, null, 2));
      console.log(` ➔ Backed up ${docs.length} documents from [${collectionName}]`);
      totalDocs += docs.length;
    }
    
    console.log(`\n🎉 Backup fully completed!`);
    console.log(`💾 Total documents saved: ${totalDocs}`);
    console.log(`📁 Backup folder location: ${backupDir}`);

  } catch (error) {
    console.error("❌ Backup failed:", error);
  } finally {
    await client.close();
  }
}

backup();
