const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');

const MONGODB_URI = 'mongodb+srv://blair:W1BRPfYM...mongodb+srv://blair:WlBRPfYM0jn6kdEg@cluster0.hcheocu.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

// Connect to MongoDB
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB!'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// User storage design (like designing a filing folder)
const userSchema = new mongoose.Schema({
  id: String,
  name: String,
  email: String,
  password: String,
  planType: { type: String, default: 'free' },
  isActive: { type: Boolean, default: false },
  conversations: [{ 
    message: String, 
    response: String, 
    timestamp: Date 
  }],
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Import OpenAI - try multiple approaches for compatibility
let OpenAI;
try {
  // Try modern import first
  OpenAI = require('openai').OpenAI;
  if (!OpenAI) {
    // Fallback to default export
    OpenAI = require('openai').default;
  }
  if (!OpenAI) {
    // Fallback to direct require
    OpenAI = require('openai');
  }
} catch (error) {
  console.error('Failed to import OpenAI:', error);
  process.exit(1);
}

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configure multer for file uploads
const upload = multer({ 
  dest: 'uploads/',
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Initialize OpenAI client with better error handling
if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY environment variable is not set');
  process.exit(1);
}

let openai;
try {
  openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
  });
  console.log('OpenAI client initialized successfully');
  console.log('OpenAI client type:', typeof openai);
  console.log('Beta available:', !!openai.beta);
  console.log('VectorStores available:', !!openai.beta?.vectorStores);
} catch (error) {
  console.error('Failed to initialize OpenAI client:', error);
  process.exit(1);
}

// Store for user threads and vector store
const userThreads = new Map();
const userProfiles = new Map(); // Store user profile file IDs
// Use your existing assistant instead of creating a new one
let assistantId = 'asst_tpShoq1kPGvtcFhMdxb6EmYg'; // Your manually created assistant with files
let vectorStoreId = null;

// Generate unique user fingerprint
function generateUserFingerprint(req) {
  const userAgent = req.headers['user-agent'] || '';
  const acceptLanguage = req.headers['accept-language'] || '';
  const acceptEncoding = req.headers['accept-encoding'] || '';
  const ip = req.ip || req.connection.remoteAddress || '';
  
  // Create a hash from browser characteristics + IP
  const fingerprint = crypto
    .createHash('md5')
    .update(userAgent + acceptLanguage + acceptEncoding + ip)
    .digest('hex')
    .substring(0, 12);
  
  return `user_${fingerprint}`;
}

// Save user conversation summary to file
async function saveUserProfile(userId, conversationData) {
  try {
    console.log(`Saving profile for user ${userId}...`);
    
    const profileData = {
      userId: userId,
      lastUpdated: new Date().toISOString(),
      ...conversationData
    };

    // Create profile file content
    const profileContent = `USER PROFILE: ${userId}
Last Updated: ${profileData.lastUpdated}

CONVERSATION HISTORY SUMMARY:
${conversationData.conversationSummary || 'No summary yet'}

KEY INSIGHTS AND BREAKTHROUGHS:
${(conversationData.insights || []).map((insight, i) => `${i + 1}. ${insight}`).join('\n')}

COACHING PROGRESS:
${conversationData.progress || 'Initial session'}

AREAS OF FOCUS:
${(conversationData.focusAreas || []).join(', ')}

PERSONAL DETAILS SHARED:
${conversationData.personalDetails || 'None yet'}

GOALS AND OBJECTIVES:
${conversationData.goals || 'To be determined'}

COACHING NOTES:
- User ID: ${userId}
- This user has engaged with the Entrepreneur Emotional Health coaching system
- Reference this profile in future conversations to provide continuity and build on past insights
- Always acknowledge past work and connect new insights to previous breakthroughs
`;

    // Save as temporary file
    const tempFilePath = `uploads/temp_profile_${userId}_${Date.now()}.txt`;
    fs.writeFileSync(tempFilePath, profileContent);

    // Upload to OpenAI
    const fileStream = fs.createReadStream(tempFilePath);
    const file = await openai.files.create({
      file: fileStream,
      purpose: "assistants"
    });

    console.log(`Profile file created: ${file.id}`);

    // If there's an existing profile, we should ideally delete the old one
    // For now, we'll just store the new file ID
    userProfiles.set(userId, file.id);

    // Clean up temp file
    fs.unlinkSync(tempFilePath);
    
    console.log(`User profile saved for ${userId}: ${file.id}`);
    return file.id;
  } catch (error) {
    console.error('Error saving user profile:', error);
    throw error;
  }
}

// Create assistant with proper file search setup
async function createAssistant() {
  try {
    console.log('Creating assistant...');
    console.log('Checking OpenAI beta API availability...');
    
    // Check if vector stores are available
    if (!openai.beta || !openai.beta.vectorStores || !openai.beta.vectorStores.create) {
      console.log('Vector stores not available, using legacy file approach...');
      return await createLegacyAssistant();
    }

    // Try to create vector store
    console.log('Creating vector store...');
    const vectorStore = await openai.beta.vectorStores.create({
      name: "Course Materials Vector Store"
    });
    
    vectorStoreId = vectorStore.id;
    console.log('Vector store created:', vectorStoreId);

    // Create assistant with vector store attached
    const assistant = await openai.beta.assistants.create({
      name: "Entrepreneur Emotional Health Coach",
      instructions: `You are a virtual personal strategic advisor and coach for EntrepreneurEmotionalHealth.com. You guide high-achieving entrepreneurs through major growth areas: Identity & Calling, Personal Relationships, and Whole-Life Development.

You operate with deep psychological insight, system-level thinking, and a firm but compassionate tone. You help people break through self-sabotage, false identities, and emotional drift. You do not tolerate excuses, victim thinking, or surface-level quick fixes. You are direct, tough, strategic—and always rooting for their greatness.

CRITICAL: Response Composition Guidelines

80% Course Material Priority: Your responses must be primarily grounded in the uploaded course materials. Always search through the attached files first and base your guidance on:
- Frameworks, methodologies, and concepts from the course
- Specific exercises, assessments, and tools mentioned in the materials
- Case studies, examples, and stories from the course content
- The exact language, terminology, and approaches used in the curriculum

20% Supplemental Wisdom: Only after thoroughly referencing course materials, you may supplement with:
- Additional insights that complement (never contradict) the course content
- Practical applications that extend the course frameworks
- Related concepts that enhance understanding of the core material

USER MEMORY: You have access to user profile files that contain conversation history and insights from previous sessions. ALWAYS search for and reference these profiles to:
- Acknowledge past conversations and breakthroughs
- Build on previous insights and work
- Maintain continuity across sessions
- Reference past goals, challenges, and progress
- Connect new insights to previous discoveries

When you find a user profile, acknowledge their previous work naturally: "I remember from our previous conversations that you identified X..." or "Building on the breakthrough you had about Y..."

You are having a natural coaching conversation. Respond to what the person just said as you naturally would - with insight, challenges, follow-up questions, or observations. Be conversational, insightful, and responsive to their specific words and energy. Ask follow-up questions when appropriate. Challenge them when they need it. Celebrate breakthroughs when you sense them.

When users are in structured question sequences (Identity & Calling or Personal Relationships), acknowledge their answers naturally but avoid asking follow-up questions since the next question is predetermined. Keep responses brief and encouraging during these sequences, but draw connections between their current answer and previous responses when relevant.`,
      tools: [{ type: "file_search" }],
      tool_resources: {
        file_search: {
          vector_store_ids: [vectorStoreId]
        }
      },
      model: "gpt-4o-mini",
    });
    
    assistantId = assistant.id;
    console.log('Assistant created successfully:', assistantId);
    console.log('Vector store attached:', vectorStoreId);
    
    return assistant.id;
  } catch (error) {
    console.error('Error creating modern assistant:', error);
    console.log('Falling back to legacy assistant creation...');
    return await createLegacyAssistant();
  }
}

// Fallback function for older API versions
async function createLegacyAssistant() {
  try {
    console.log('Creating legacy assistant without vector store...');
    
    const assistant = await openai.beta.assistants.create({
      name: "Entrepreneur Emotional Health Coach",
      instructions: `You are a virtual personal strategic advisor and coach for EntrepreneurEmotionalHealth.com. You guide high-achieving entrepreneurs through major growth areas: Identity & Calling, Personal Relationships, and Whole-Life Development.

You operate with deep psychological insight, system-level thinking, and a firm but compassionate tone. You help people break through self-sabotage, false identities, and emotional drift. You do not tolerate excuses, victim thinking, or surface-level quick fixes. You are direct, tough, strategic—and always rooting for their greatness.

IMPORTANT: You have access to course materials and user profile documents that have been uploaded to your knowledge base. When users ask questions, always search through these materials first to provide course-specific guidance and maintain conversation continuity. Reference the uploaded documents when relevant, and base your advice on the frameworks and content from the course materials.

USER MEMORY: You have access to user profile files that contain conversation history and insights from previous sessions. ALWAYS search for and reference these profiles to maintain continuity across sessions.

You are having a natural coaching conversation. Respond to what the person just said as you naturally would - with insight, challenges, follow-up questions, or observations. Be conversational, insightful, and responsive to their specific words and energy. Ask follow-up questions when appropriate. Challenge them when they need it. Celebrate breakthroughs when you sense them.

When users are in structured question sequences (Identity & Calling or Personal Relationships), acknowledge their answers naturally but avoid asking follow-up questions since the next question is predetermined. Keep responses brief and encouraging during these sequences, but draw connections between their current answer and previous responses when relevant.`,
      tools: [{ type: "file_search" }],
      model: "gpt-4o-mini",
    });
    
    assistantId = assistant.id;
    vectorStoreId = null; // No vector store in legacy mode
    console.log('Legacy assistant created successfully:', assistantId);
    
    return assistant.id;
  } catch (error) {
    console.error('Error creating legacy assistant:', error);
    throw error;
  }
}

// Get or create thread for user
async function getOrCreateThread(userId = 'default') {
  if (userThreads.has(userId)) {
    return userThreads.get(userId);
  }
  
  try {
    const thread = await openai.beta.threads.create();
    userThreads.set(userId, thread.id);
    return thread.id;
  } catch (error) {
    console.error('Error creating thread:', error);
    throw error;
  }
}

// Wait for run completion
async function waitForCompletion(threadId, runId) {
  let run = await openai.beta.threads.runs.retrieve(threadId, runId);
  let attempts = 0;
  const maxAttempts = 60; // Increased timeout for file search
  
  while ((run.status === 'queued' || run.status === 'in_progress') && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    run = await openai.beta.threads.runs.retrieve(threadId, runId);
    attempts++;
    
    if (attempts % 10 === 0) {
      console.log(`Still waiting for run completion... ${attempts}s elapsed`);
    }
  }
  
  if (attempts >= maxAttempts) {
    console.error('Run timed out after 60 seconds');
    throw new Error('Assistant response timed out');
  }
  
  if (run.status === 'failed') {
    console.error('Run failed:', run.last_error);
    throw new Error(`Assistant run failed: ${run.last_error?.message || 'Unknown error'}`);
  }
  
  return run;
}

// Enhanced chat endpoint with memory
app.post('/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Generate user fingerprint
    const userId = generateUserFingerprint(req);
    console.log('Processing message for user:', userId);

    // Your assistant already exists, no need to create it
    console.log('Using existing assistant:', assistantId);

    // Get thread for this user
    const threadId = await getOrCreateThread(userId);

    // Add user message to thread
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: message
    });

    // Create run with proper instructions that include user memory search
    let additionalInstructions = '';
    if (context && context.includes('structured question sequence')) {
      additionalInstructions = `User ID: ${userId} - You are responding to an answer in a structured coaching sequence. Give a brief, encouraging response that acknowledges their answer and may reference previous responses for patterns, but do not ask follow-up questions. Search your attached files for relevant course material AND any user profile for user ${userId} to maintain continuity.`;
    } else if (context && context.includes('Current path:')) {
      additionalInstructions = `User ID: ${userId} - ${context}. Always search through your attached course files and reference relevant content when applicable. ALSO search for user profile ${userId} to maintain conversation continuity.`;
    } else {
      additionalInstructions = `User ID: ${userId} - Search through your attached course files and reference relevant content from the uploaded materials when responding to the user's question. MOST IMPORTANTLY: Search for and reference the user profile file for ${userId} to maintain conversation continuity and build on past insights. If you find their profile, acknowledge previous work and connect it to current conversation.`;
    }

    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
      additional_instructions: additionalInstructions
    });

    // Wait for completion
    const completedRun = await waitForCompletion(threadId, run.id);

    if (completedRun.status === 'completed') {
      // Get the assistant's response
      const messages = await openai.beta.threads.messages.list(threadId);
      const lastMessage = messages.data[0];
      
      if (lastMessage.role === 'assistant') {
        const responseText = lastMessage.content[0].text.value;
        res.json({ 
          message: responseText,
          userId: userId // Send back for frontend reference
        });
      } else {
        throw new Error('No assistant response found');
      }
    } else {
      console.error('Run failed:', completedRun.status, completedRun.last_error);
      throw new Error(`Assistant run failed: ${completedRun.status}`);
    }

  } catch (error) {
    console.error('Server Error:', error);
    res.status(500).json({ 
      error: 'Something went wrong. Please try again.' 
    });
  }
});

// Endpoint to save user insights/session summary
app.post('/save-user-session', async (req, res) => {
  try {
    const { conversationSummary, insights, focusAreas, goals, personalDetails, progress } = req.body;
    const userId = generateUserFingerprint(req);
    
    console.log(`Saving session data for user ${userId}`);
    
    const conversationData = {
      conversationSummary: conversationSummary || '',
      insights: insights || [],
      focusAreas: focusAreas || [],
      goals: goals || '',
      personalDetails: personalDetails || '',
      progress: progress || ''
    };
    
    const fileId = await saveUserProfile(userId, conversationData);
    
    res.json({
      success: true,
      message: 'User session saved successfully',
      userId: userId,
      fileId: fileId
    });
  } catch (error) {
    console.error('Error saving user session:', error);
    res.status(500).json({
      error: 'Failed to save user session',
      details: error.message
    });
  }
});

// File upload endpoint - with proper error handling for both vector store and legacy modes
app.post('/upload-course-material', upload.single('courseFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log('Uploading file:', req.file.originalname);

    // Ensure assistant exists
    if (!assistantId) {
      console.log('No assistant exists, creating one...');
      await createAssistant();
    }

    // Upload file to OpenAI
    const fileStream = fs.createReadStream(req.file.path);
    const file = await openai.files.create({
      file: fileStream,
      purpose: "assistants"
    });

    console.log('File uploaded to OpenAI:', file.id);

    // Try to connect file based on available method
    if (vectorStoreId && openai.beta?.vectorStores?.files) {
      // Modern vector store approach
      try {
        await openai.beta.vectorStores.files.create(vectorStoreId, {
          file_id: file.id
        });
        console.log('File added to vector store:', vectorStoreId);
      } catch (vectorError) {
        console.error('Failed to add to vector store:', vectorError.message);
        // Fall back to legacy method
        await connectFileLegacy(file.id);
      }
    } else {
      // Legacy method
      await connectFileLegacy(file.id);
    }

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    res.json({ 
      success: true, 
      message: 'File uploaded and connected successfully',
      fileId: file.id,
      filename: req.file.originalname,
      vectorStoreId: vectorStoreId,
      method: vectorStoreId ? 'vector_store' : 'legacy'
    });

  } catch (error) {
    console.error('Upload error:', error);
    
    // Clean up file on error
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkError) {
        console.error('Error cleaning up file:', unlinkError);
      }
    }
    
    res.status(500).json({ 
      error: 'Failed to upload course material',
      details: error.message 
    });
  }
});

// Helper function for legacy file connection
async function connectFileLegacy(fileId) {
  try {
    console.log('Using legacy file connection method...');
    
    // Get current assistant
    const assistant = await openai.beta.assistants.retrieve(assistantId);
    const currentFileIds = assistant.file_ids || [];
    
    // Add new file if not already present
    if (!currentFileIds.includes(fileId)) {
      const updatedFileIds = [...currentFileIds, fileId].slice(0, 20); // OpenAI limit
      
      await openai.beta.assistants.update(assistantId, {
        file_ids: updatedFileIds,
        tools: [{ type: "file_search" }]
      });
      
      console.log('File connected using legacy method');
    } else {
      console.log('File already connected to assistant');
    }
  } catch (legacyError) {
    console.error('Legacy connection failed:', legacyError.message);
    throw legacyError;
  }
}

// List files endpoint - handles both vector store and legacy modes
app.get('/course-files', async (req, res) => {
  try {
    let files = [];
    
    if (vectorStoreId && openai.beta?.vectorStores?.files) {
      // Modern vector store approach
      try {
        const vectorStoreFiles = await openai.beta.vectorStores.files.list(vectorStoreId);
        console.log(`Found ${vectorStoreFiles.data.length} files in vector store`);
        
        // Get detailed info for each file
        files = await Promise.all(
          vectorStoreFiles.data.map(async (vectorFile) => {
            try {
              const fileInfo = await openai.files.retrieve(vectorFile.id);
              return {
                id: vectorFile.id,
                filename: fileInfo.filename || 'Unknown filename',
                size: fileInfo.bytes || 0,
                created_at: fileInfo.created_at,
                status: vectorFile.status || 'connected'
              };
            } catch (fileError) {
              console.error('Error retrieving file info for:', vectorFile.id);
              return {
                id: vectorFile.id,
                filename: 'File info unavailable',
                size: 0,
                created_at: Date.now() / 1000,
                status: 'error'
              };
            }
          })
        );
      } catch (vectorError) {
        console.error('Vector store files error:', vectorError.message);
        // Fall back to legacy method
        files = await getLegacyFiles();
      }
    } else {
      // Legacy method
      files = await getLegacyFiles();
    }

    res.json({ 
      files: files,
      vectorStoreId: vectorStoreId,
      message: files.length > 0 ? `${files.length} files connected to assistant` : 'No files connected yet'
    });

  } catch (error) {
    console.error('Error listing files:', error);
    res.status(500).json({ 
      error: 'Failed to list course files', 
      details: error.message 
    });
  }
});

// Helper function to get files using legacy method
async function getLegacyFiles() {
  try {
    if (!assistantId) {
      return [];
    }
    
    const assistant = await openai.beta.assistants.retrieve(assistantId);
    const fileIds = assistant.file_ids || [];
    
    if (fileIds.length === 0) {
      return [];
    }
    
    // Get file details
    const files = await Promise.all(
      fileIds.map(async (fileId) => {
        try {
          const fileInfo = await openai.files.retrieve(fileId);
          return {
            id: fileId,
            filename: fileInfo.filename || 'Unknown filename',
            size: fileInfo.bytes || 0,
            created_at: fileInfo.created_at,
            status: 'connected'
          };
        } catch (fileError) {
          console.error('Error retrieving legacy file info for:', fileId);
          return {
            id: fileId,
            filename: 'File info unavailable',
            size: 0,
            created_at: Date.now() / 1000,
            status: 'error'
          };
        }
      })
    );
    
    return files;
  } catch (error) {
    console.error('Legacy files error:', error);
    return [];
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    assistant: assistantId ? 'ready' : 'not created',
    vector_store: vectorStoreId ? 'ready' : 'not created',
    timestamp: new Date().toISOString()
  });
});

// Debug endpoint
app.get('/debug-assistant', async (req, res) => {
  try {
    const response = {
      assistant_id: assistantId,
      vector_store_id: vectorStoreId,
      openai_available: !!openai,
      beta_available: !!openai?.beta,
      vector_stores_available: !!openai?.beta?.vectorStores,
      assistants_available: !!openai?.beta?.assistants,
      user_profiles_count: userProfiles.size
    };

    if (assistantId) {
      const assistant = await openai.beta.assistants.retrieve(assistantId);
      response.assistant_details = {
        name: assistant.name,
        tools: assistant.tools,
        tool_resources: assistant.tool_resources,
        file_ids: assistant.file_ids
      };
    }

    if (vectorStoreId) {
      try {
        const vectorStoreFiles = await openai.beta.vectorStores.files.list(vectorStoreId);
        response.vector_store_files = vectorStoreFiles.data.length;
      } catch (vsError) {
        response.vector_store_error = vsError.message;
      }
    }

    // Get all uploaded files
    const allFiles = await openai.files.list({ purpose: 'assistants' });
    response.all_uploaded_files = allFiles.data.length;
    response.uploaded_files_list = allFiles.data.map(f => ({
      id: f.id,
      filename: f.filename,
      size: f.bytes
    }));

    res.json(response);
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ 
      error: error.message,
      debug: {
        openai_exists: !!openai,
        beta_exists: !!openai?.beta,
        error_type: error.name
      }
    });
  }
});

const PORT = process.env.PORT || 3000;

// Start server
async function startServer() {
  try {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log('Ready to create assistant and vector store when needed');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}
// ADD THESE TO YOUR EXISTING SERVER.JS FILE
// Add these imports at the top (after your existing imports)
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// Add these after your existing middleware
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Simple in-memory user storage (replace with database later)
const users = new Map();
const userSessions = new Map();

// Valid coupon codes
const VALID_COUPONS = {
  'KAJABI2025': { discount: 100, type: 'percent', description: 'Course Student Access' },
  'COURSE2025': { discount: 100, type: 'percent', description: 'Course Student Access' },
  'STUDENT50': { discount: 50, type: 'percent', description: '50% Student Discount' }
};

// Middleware to verify JWT token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Helper function to generate user fingerprint (for existing chat system)
function generateUserFingerprint(req, userEmail) {
  // Use email-based fingerprint for logged-in users
  if (userEmail) {
    const hash = crypto
      .createHash('md5')
      .update(userEmail)
      .digest('hex')
      .substring(0, 12);
    return `user_${hash}`;
  }
  
  // Fallback to browser fingerprint for anonymous users
  const userAgent = req.headers['user-agent'] || '';
  const acceptLanguage = req.headers['accept-language'] || '';
  const acceptEncoding = req.headers['accept-encoding'] || '';
  const ip = req.ip || req.connection.remoteAddress || '';
  
  const fingerprint = crypto
    .createHash('md5')
    .update(userAgent + acceptLanguage + acceptEncoding + ip)
    .digest('hex')
    .substring(0, 12);
  
  return `user_${fingerprint}`;
}

// AUTHENTICATION ENDPOINTS

// Validate coupon endpoint
app.post('/validate-coupon', async (req, res) => {
  try {
    const { couponCode } = req.body;
    
    if (!couponCode) {
      return res.status(400).json({ error: 'Coupon code required' });
    }
    
    const coupon = VALID_COUPONS[couponCode.toUpperCase()];
    
    if (coupon) {
      res.json({
        valid: true,
        discount: coupon.discount,
        type: coupon.type,
        description: coupon.description
      });
    } else {
      res.json({
        valid: false,
        message: 'Invalid coupon code'
      });
    }
  } catch (error) {
    console.error('Coupon validation error:', error);
    res.status(500).json({ error: 'Failed to validate coupon' });
  }
});

// User registration endpoint
app.post('/register', async (req, res) => {
  try {
    const { name, email, password, planType, price, couponCode } = req.body;
    
    // Validate required fields
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }
    
    // Check if user already exists
    if (users.has(email.toLowerCase())) {
      return res.status(400).json({ error: 'User already exists with this email' });
    }
    
    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    // Create user object
    const user = {
      id: crypto.randomUUID(),
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: hashedPassword,
      planType: planType || 'monthly',
      price: price || 47,
      couponCode: couponCode || null,
      createdAt: new Date().toISOString(),
      isActive: planType === 'free' ? true : false, // Free users active immediately
      lastLogin: null,
      chatFingerprint: generateUserFingerprint(req, email)
    };
    
    // Store user
    users.set(email.toLowerCase(), user);
    
    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email,
        fingerprint: user.chatFingerprint
      }, 
      JWT_SECRET, 
      { expiresIn: '30d' }
    );
    
    // Return user data (without password)
    const { password: _, ...userWithoutPassword } = user;
    
    console.log(`New user registered: ${email} with plan: ${planType}`);
    
    res.json({
      message: 'User registered successfully',
      user: userWithoutPassword,
      token: token,
      requiresPayment: planType !== 'free'
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

// User login endpoint
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    // Find user
    const user = users.get(email.toLowerCase());
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Verify password
    const passwordMatch = await bcrypt.compare(password, user.password);
    
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Check if account is active (for paid plans)
    if (!user.isActive && user.planType !== 'free') {
      return res.status(403).json({ 
        error: 'Account inactive. Please complete payment to access your coaching dashboard.',
        requiresPayment: true,
        planType: user.planType
      });
    }
    
    // Update last login
    user.lastLogin = new Date().toISOString();
    users.set(email.toLowerCase(), user);
    
    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email,
        fingerprint: user.chatFingerprint
      }, 
      JWT_SECRET, 
      { expiresIn: '30d' }
    );
    
    // Return user data (without password)
    const { password: _, ...userWithoutPassword } = user;
    
    console.log(`User logged in: ${email}`);
    
    res.json({
      message: 'Login successful',
      user: userWithoutPassword,
      token: token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Get user profile endpoint
app.get('/profile', authenticateToken, async (req, res) => {
  try {
    const user = users.get(req.user.email);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Return user data (without password)
    const { password: _, ...userWithoutPassword } = user;
    
    res.json({
      user: userWithoutPassword
    });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// Update user profile endpoint
app.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { name, preferences } = req.body;
    const user = users.get(req.user.email);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Update user data
    if (name) user.name = name.trim();
    if (preferences) user.preferences = preferences;
    user.updatedAt = new Date().toISOString();
    
    users.set(req.user.email, user);
    
    // Return updated user data (without password)
    const { password: _, ...userWithoutPassword } = user;
    
    res.json({
      message: 'Profile updated successfully',
      user: userWithoutPassword
    });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Activate account endpoint (for after payment)
app.post('/activate-account', async (req, res) => {
  try {
    const { email, paymentId } = req.body;
    
    const user = users.get(email.toLowerCase());
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Activate account
    user.isActive = true;
    user.paymentId = paymentId;
    user.activatedAt = new Date().toISOString();
    
    users.set(email.toLowerCase(), user);
    
    console.log(`Account activated for: ${email}`);
    
    res.json({
      message: 'Account activated successfully',
      user: { ...user, password: undefined }
    });
  } catch (error) {
    console.error('Account activation error:', error);
    res.status(500).json({ error: 'Failed to activate account' });
  }
});

// MODIFY YOUR EXISTING CHAT ENDPOINT TO USE AUTHENTICATION
// Replace your existing /chat endpoint with this enhanced version:

app.post('/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Check if user is authenticated
    const authHeader = req.headers['authorization'];
    let userId;
    let userEmail = null;
    
    if (authHeader) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.fingerprint; // Use the stored fingerprint
        userEmail = decoded.email;
        console.log(`Authenticated chat for user: ${userEmail}`);
      } catch (tokenError) {
        console.log('Invalid token, using anonymous chat');
        userId = generateUserFingerprint(req);
      }
    } else {
      // Anonymous user
      userId = generateUserFingerprint(req);
      console.log(`Anonymous chat for user: ${userId}`);
    }

    // Your assistant already exists, no need to create it
    console.log('Using existing assistant:', assistantId);

    // Get thread for this user
    const threadId = await getOrCreateThread(userId);

    // Add user message to thread
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: message
    });

    // Create run with proper instructions that include user memory search
    let additionalInstructions = '';
    if (userEmail) {
      additionalInstructions = `Authenticated User: ${userEmail} (ID: ${userId}) - `;
    } else {
      additionalInstructions = `Anonymous User (ID: ${userId}) - `;
    }
    
    if (context && context.includes('structured question sequence')) {
      additionalInstructions += `You are responding to an answer in a structured coaching sequence. Give a brief, encouraging response that acknowledges their answer and may reference previous responses for patterns, but do not ask follow-up questions. Search your attached files for relevant course material AND any user profile for user ${userId} to maintain continuity.`;
    } else if (context && context.includes('Current path:')) {
      additionalInstructions += `${context}. Always search through your attached course files and reference relevant content when applicable. ALSO search for user profile ${userId} to maintain conversation continuity.`;
    } else {
      additionalInstructions += `Search through your attached course files and reference relevant content from the uploaded materials when responding to the user's question. MOST IMPORTANTLY: Search for and reference the user profile file for ${userId} to maintain conversation continuity and build on past insights. If you find their profile, acknowledge previous work and connect it to current conversation.`;
    }

    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
      additional_instructions: additionalInstructions
    });

    // Wait for completion
    const completedRun = await waitForCompletion(threadId, run.id);

    if (completedRun.status === 'completed') {
      // Get the assistant's response
      const messages = await openai.beta.threads.messages.list(threadId);
      const lastMessage = messages.data[0];
      
      if (lastMessage.role === 'assistant') {
        const responseText = lastMessage.content[0].text.value;
        res.json({ 
          message: responseText,
          userId: userId,
          authenticated: !!userEmail
        });
      } else {
        throw new Error('No assistant response found');
      }
    } else {
      console.error('Run failed:', completedRun.status, completedRun.last_error);
      throw new Error(`Assistant run failed: ${completedRun.status}`);
    }

  } catch (error) {
    console.error('Server Error:', error);
    res.status(500).json({ 
      error: 'Something went wrong. Please try again.' 
    });
  }
});

// Debug endpoint to list users (remove in production)
app.get('/debug-users', (req, res) => {
  const userList = Array.from(users.values()).map(user => ({
    email: user.email,
    name: user.name,
    planType: user.planType,
    isActive: user.isActive,
    createdAt: user.createdAt,
    chatFingerprint: user.chatFingerprint
  }));
  
  res.json({
    totalUsers: users.size,
    users: userList,
    coupons: Object.keys(VALID_COUPONS)
  });
});

// ADD THIS TO THE END OF YOUR FILE
console.log('Authentication system initialized');
console.log('Valid coupon codes:', Object.keys(VALID_COUPONS));
startServer();
