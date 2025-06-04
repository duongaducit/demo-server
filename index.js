const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const hostname = '0.0.0.0';
const port = 3000;

const mongoUrl = 'mongodb://localhost:27017/?retryWrites=true&w=majority&appName=sato_pc';
const dbName = 'sato_pc'; // You can change this to your preferred database name
let db;

const JWT_SECRET = 'your_secret_key_here'; // Change to a secure value in production

const app = express();
app.use(express.json());

// CORS middleware
app.use(cors({
  origin: [
    'http://localhost:4200',
    'http://localhost:8080',
    'http://192.85.4.69:4200'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
  credentials: true
}));

// Middleware to check JWT token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

app.get('/products', authenticateToken, async (req, res) => {
  try {
    const products = await db.collection('products').find({}).toArray();
    res.status(200).json(products);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.get('/', (req, res) => {
  res.send('Hello, World!');
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  try {
    const user = await db.collection('login').findOne({ username, password });
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    // Generate JWT token
    const token = jwt.sign({ username: user.username, mode: user.mode }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ ...user, token });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/checklists', authenticateToken, async (req, res) => {
  try {
    // Only get checklists for the currently logged-in user, sorted by date_create desc
    const checklists = await db.collection('checklists')
      .find({ user: req.user.username })
      .sort({ date_create: -1 })
      .toArray();
    // Get checklist_detail counts and details grouped by checklist_id
    const detailsAgg = await db.collection('checklist_detail').aggregate([
      { $group: { _id: '$checklist_id', total: { $sum: 1 }, details: { $push: '$$ROOT' } } }
    ]).toArray();
    const detailMap = Object.fromEntries(detailsAgg.map(d => [d._id, { total: d.total, details: d.details }]));
    // Get all products (jancode -> name)
    const products = await db.collection('products').find({}, { projection: { jancode: 1, name: 1 } }).toArray();
    const productNameMap = Object.fromEntries(products.map(p => [p.jancode, p.name]));
    const result = checklists.map(cl => {
      const details = (detailMap[cl.checklist_id]?.details || []).map(detail => ({
        ...detail,
        name: productNameMap[detail.jancode] || null
      }));
      return {
        ...cl,
        total: detailMap[cl.checklist_id]?.total || 0,
        details
      };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch checklists' });
  }
});

app.post('/update-product', authenticateToken, async (req, res) => {
  const { checklistId, jancode, dateline } = req.body;
  if (!checklistId || !jancode || !dateline) {
    return res.status(400).json({ error: 'checklistId, jancode, and dateline are required' });
  }
  try {
    const filter = { checklist_id: parseInt(checklistId, 10), jancode };
    const update = {
      $set: {
        dateline,
        datetime: new Date().toISOString()
      }
    };
    const result = await db.collection('checklist_detail').updateOne(filter, update);
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Checklist detail not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update product' });
  }
});

app.get('/all-user', async (req, res) => {
  try {
    const users = await db.collection('login').find({}, { projection: { password: 0 } }).toArray();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.post('/change-mode', async (req, res) => {
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  try {
    const user = await db.collection('login').findOne({ username });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const newMode = user.mode === 1 ? 0 : 1;
    await db.collection('login').updateOne({ username }, { $set: { mode: newMode } });
    const updatedUser = await db.collection('login').findOne({ username }, { projection: { password: 0 } });
    res.json(updatedUser);
  } catch (err) {
    res.status(500).json({ error: 'Failed to change mode' });
  }
});

app.get('/settings-ocr', async (req, res) => {
  try {
    const settings = await db.collection('settings_ocr').find({}).toArray();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings_ocr' });
  }
});

app.post('/settings-ocr', async (req, res) => {
  const { value } = req.body;
  if (!value) {
    return res.status(400).json({ error: 'Value is required' });
  }
  try {
    const result = await db.collection('settings_ocr').insertOne({ value });
    res.json({ value: value, _id: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to insert settings_ocr' });
  }
});

app.post('/delete-settings-ocr', async (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }
  try {
    const result = await db.collection('settings_ocr').deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'settings_ocr not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete settings_ocr' });
  }
});

app.get('/search-checklists', async (req, res) => {
  try {
    // Get all products count
    const count = await db.collection('products').countDocuments();
    const num = Math.floor(Math.random() * 11) + 20; // 20-30
    // Get random skip values
    const skips = new Set();
    while (skips.size < num) {
      skips.add(Math.floor(Math.random() * count));
    }
    const products = [];
    for (const skip of skips) {
      const product = await db.collection('products').find().skip(skip).limit(1).toArray();
      if (product[0]) {
        products.push({
          ...product[0],
          dateline: 'null',
          datetime: 'null'
        });
      }
    }
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: 'Failed to search checklists' });
  }
});

app.post('/create-checklist', authenticateToken, async (req, res) => {
  const { jancodes } = req.body;
  if (!Array.isArray(jancodes) || jancodes.length === 0) {
    return res.status(400).json({ error: 'jancodes must be a non-empty array' });
  }
  try {
    // Get the next checklist_id
    const lastChecklist = await db.collection('checklists').find().sort({ checklist_id: -1 }).limit(1).toArray();
    const nextChecklistId = lastChecklist.length > 0 ? lastChecklist[0].checklist_id + 1 : 1;
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const checklist = {
      checklist_id: nextChecklistId,
      checklist_name: `チェックリスト ${dateStr}`,
      date_create: dateStr,
      status: 0,
      user: req.user.username
    };
    await db.collection('checklists').insertOne(checklist);
    const details = jancodes.map(jancode => ({
      checklist_id: nextChecklistId,
      jancode,
      dateline: null,
      datetime: null
    }));
    await db.collection('checklist_detail').insertMany(details);
    // Join with products to get name for each jancode
    const products = await db.collection('products').find({ jancode: { $in: jancodes } }, { projection: { jancode: 1, name: 1 } }).toArray();
    const productNameMap = Object.fromEntries(products.map(p => [p.jancode, p.name]));
    const detailsWithName = details.map(d => ({
      ...d,
      name: productNameMap[d.jancode] || null
    }));
    const data = { ...checklist, details: detailsWithName };
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create checklist' });
  }
});

app.get('/product/:jancode', async (req, res) => {
  const { jancode } = req.params;
  try {
    const product = await db.collection('products').findOne({ jancode });
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

app.post('/create-product', authenticateToken, async (req, res) => {
  const { jancode, dateline } = req.body;
  if (!jancode || !dateline) {
    return res.status(400).json({ error: 'jancode and dateline are required' });
  }
  try {
    // Check if product exists
    const product = await db.collection('products').findOne({ jancode });
    const newProduct = {
      jancode,
      name: '商品マスタなし',
      dateline,
      date_discount: 60,
      date_recall: 40
    };
    if (!product) {
      // Insert new product
      await db.collection('products').insertOne(newProduct);
      // Insert into custome_products with user
    } 
    const customProduct = {
      ...newProduct,
      user: req.user.username
    };
    await db.collection('custom_products').insertOne(customProduct);
    return res.json({ success: true, product: newProduct, customProduct });
    
  } catch (err) {
    res.status(500).json({ error: 'Failed to create product' });
  }
});

app.get('/custom-products', authenticateToken, async (req, res) => {
  try {
    const products = await db.collection('custom_products').find({ user: req.user.username }).toArray();
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch custom products' });
  }
});

MongoClient.connect(mongoUrl, { useUnifiedTopology: true })
  .then(async client => {
    db = client.db(dbName);
    console.log('Connected to MongoDB');
    app.listen(port, hostname, () => {
      console.log(`Server running at http://${hostname}:${port}/`);
    });
  })
  .catch(err => {
    console.error('Failed to connect to MongoDB', err);
    process.exit(1);
  }); 