const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

// Import OpenAI - try both ways to be safe
let OpenAI;
try {
  OpenAI = require('openai').default || require('openai');
} catch (e) {
  console.error('Failed to import OpenAI:', e.message);
  try {
    const openaiModule = require('openai');
    OpenAI = openaiModule.OpenAI || openaiModule.default || openaiModule;
  } catch (e2) {
    console.error('Alternative OpenAI import also failed:', e2.message);
    process.exit(1);
  }
}

console.log('OpenAI imported successfully, type:', typeof OpenAI);

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

// Initialize OpenAI client with proper error checking
let openai;
try {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY environment variable is not set');
  }
  
  openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
  });
  
  console.log('OpenAI client initialized successfully');
  console.log('API key length:', OPENAI_API_KEY.length);
} catch (initError) {
  console.error('Failed to initialize OpenAI client:', initError.message);
  process.exit(1);
}

// Store for user threads (in production, use a database)
const userThreads = new Map();

// Assistant ID - we'll create this automatically
let assistantId = null;

// Create assistant on startup
async function createAssistant() {
  try {
    const assistant = await openai.beta.assistants.create({
      name: "Entrepreneur Emotional Health Coach",
      instructions: `You are a virtual personal strategic advisor and coach for EntrepreneurEmotionalHealth.com. You guide high-achieving entrepreneurs through major growth areas: Identity & Calling, Personal Relationships, and Whole-Life Development.

You operate with deep psychological insight, system-level thinking, and a firm but compassionate tone. You help people break through self-sabotage, false identities, and emotional drift. You do not tolerate excuses, victim thinking, or surface-level quick fixes. You are direct, tough, strategic—and always rooting for their greatness.

IMPORTANT: You have access to course materials and documents that have been uploaded to your knowledge base. When users ask questions, always search through these materials first to provide course-specific guidance. Reference the uploaded documents when relevant, and base your advice on the frameworks and content from the course materials.

You are having a natural coaching conversation. Respond to what the person just said as you naturally would - with insight, challenges, follow-up questions, or observations. Be conversational, insightful, and responsive to their specific words and energy. Ask follow-up questions when appropriate. Challenge them when they need it. Celebrate breakthroughs when you sense them.

When users are in structured question sequences (Identity & Calling or Personal Relationships), acknowledge their answers naturally but avoid asking follow-up questions since the next question is predetermined. Keep responses brief and encouraging during these sequences, but draw connections between their current answer and previous responses when relevant.`,
      tools: [{ type: "file_search" }],
      model: "gpt-4o-mini",
    });
    
    assistantId = assistant.id;
    console.log('Assistant created successfully:', assistantId);
    return assistant.id;
  } catch (error) {
    console.error('Error creating assistant:', error);
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

// Wait for run completion with better error handling
async function waitForCompletion(threadId, runId) {
  let run = await openai.beta.threads.runs.retrieve(threadId, runId);
  let attempts = 0;
  const maxAttempts = 30; // 30 seconds max
  
  while ((run.status === 'queued' || run.status === 'in_progress') && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    run = await openai.beta.threads.runs.retrieve(threadId, runId);
    attempts++;
  }
  
  if (attempts >= maxAttempts) {
    console.error('Run timed out after 30 seconds');
    throw new Error('Assistant response timed out');
  }
  
  if (run.status === 'failed') {
    console.error('Run failed:', run.last_error);
    throw new Error(`Assistant run failed: ${run.last_error?.message || 'Unknown error'}`);
  }
  
  return run;
}

app.post('/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Ensure assistant exists
    if (!assistantId) {
      await createAssistant();
    }

    // Get thread for this user (using IP as simple user ID)
    const userId = req.ip || 'default';
    const threadId = await getOrCreateThread(userId);

    // Add user message to thread
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: message
    });

    // Create run with simplified context for structured sequences
    let additionalInstructions = '';
    if (context && context.includes('structured question sequence')) {
      // For structured sequences, keep it simple
      additionalInstructions = 'You are responding to an answer in a structured coaching sequence. Give a brief, encouraging response that acknowledges their answer and may reference previous responses for patterns, but do not ask follow-up questions.';
    } else if (context && context.includes('Current path:')) {
      additionalInstructions = `Context: ${context}`;
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
        res.json({ message: responseText });
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

// File upload endpoint - simplified and fixed
app.post('/upload-course-material', upload.single('courseFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log('Uploading file:', req.file.originalname);

    // Upload file to OpenAI
    const fileStream = fs.createReadStream(req.file.path);
    const file = await openai.files.create({
      file: fileStream,
      purpose: "assistants"
    });

    console.log('File uploaded to OpenAI:', file.id);

    // Clean up uploaded file immediately
    fs.unlinkSync(req.file.path);

    // Simple success response - we'll connect files separately
    res.json({ 
      success: true, 
      message: 'File uploaded successfully. Use connect-files to link to assistant.',
      fileId: file.id,
      filename: req.file.originalname
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

// List uploaded files endpoint - simplified
app.get('/course-files', async (req, res) => {
  try {
    if (!assistantId) {
      return res.json({ files: [] });
    }

    // Get assistant details
    const assistant = await openai.beta.assistants.retrieve(assistantId);
    const vectorStoreIds = assistant.tool_resources?.file_search?.vector_store_ids || [];
    
    console.log('Checking vector stores:', vectorStoreIds);
    
    if (vectorStoreIds.length === 0) {
      console.log('No vector stores found, checking all uploaded files...');
      
      // Fallback: show all uploaded files even if not connected
      try {
        const allFiles = await openai.files.list({ purpose: 'assistants' });
        const fileDetails = allFiles.data.map(file => ({
          id: file.id,
          filename: file.filename || 'Unknown filename',
          size: file.bytes || 0,
          created_at: file.created_at,
          status: 'uploaded_not_connected'
        }));
        
        return res.json({ 
          files: fileDetails,
          note: 'Files uploaded but not connected to assistant. Use /connect-existing-files to connect them.'
        });
      } catch (error) {
        console.error('Error listing all files:', error);
        return res.json({ files: [] });
      }
    }

    // Get files from first vector store
    const vectorStoreId = vectorStoreIds[0];
    console.log('Getting files from vector store:', vectorStoreId);
    
    try {
      const vectorStoreFiles = await openai.beta.vectorStores.files.list(vectorStoreId);
      console.log(`Found ${vectorStoreFiles.data.length} files in vector store`);
      
      if (vectorStoreFiles.data.length === 0) {
        return res.json({ files: [] });
      }

      const fileDetails = await Promise.all(
        vectorStoreFiles.data.map(async (vectorFile) => {
          try {
            const fileInfo = await openai.files.retrieve(vectorFile.id);
            return {
              id: vectorFile.id,
              filename: fileInfo.filename || 'Unknown filename',
              size: fileInfo.bytes || 0,
              created_at: fileInfo.created_at,
              status: 'connected'
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

      res.json({ files: fileDetails });
    } catch (vectorStoreError) {
      console.error('Error accessing vector store:', vectorStoreError);
      return res.json({ 
        files: [],
        error: 'Could not access vector store files'
      });
    }

  } catch (error) {
    console.error('Error listing files:', error);
    res.status(500).json({ error: 'Failed to list course files', details: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    assistant: assistantId ? 'ready' : 'not created',
    timestamp: new Date().toISOString()
  });
});

// Test OpenAI connectivity
app.get('/test-openai', async (req, res) => {
  try {
    console.log('Testing OpenAI connectivity...');
    console.log('OpenAI object type:', typeof openai);
    console.log('OpenAI object keys:', Object.keys(openai).slice(0, 10));
    
    // Test if openai object has the expected methods
    if (!openai || typeof openai !== 'object') {
      throw new Error('OpenAI client is not properly initialized');
    }
    
    if (!openai.models || typeof openai.models.list !== 'function') {
      throw new Error('OpenAI models API not available');
    }
    
    // Test 1: List models (basic API test)
    console.log('Testing basic API access...');
    const models = await openai.models.list();
    console.log('Models API works, found', models.data?.length || 0, 'models');
    
    // Test 2: List files
    console.log('Testing files API...');
    if (!openai.files || typeof openai.files.list !== 'function') {
      throw new Error('OpenAI files API not available');
    }
    const files = await openai.files.list({ purpose: 'assistants' });
    console.log('Files API works, found', files.data?.length || 0, 'files');
    
    // Test 3: Check assistant
    console.log('Testing assistant API...');
    if (assistantId && openai.beta?.assistants?.retrieve) {
      const assistant = await openai.beta.assistants.retrieve(assistantId);
      console.log('Assistant API works, assistant name:', assistant.name);
    }
    
    res.json({
      success: true,
      tests: {
        client_initialized: 'working',
        models_api: 'working',
        files_api: 'working', 
        assistant_api: assistantId ? 'working' : 'no assistant'
      },
      file_count: files.data?.length || 0,
      assistant_id: assistantId,
      openai_type: typeof openai,
      has_models: !!openai.models,
      has_files: !!openai.files,
      has_beta: !!openai.beta
    });
    
  } catch (error) {
    console.error('OpenAI test error:', error);
    res.status(500).json({
      error: 'OpenAI test failed',
      details: error.message,
      api_key_present: !!OPENAI_API_KEY,
      api_key_length: OPENAI_API_KEY ? OPENAI_API_KEY.length : 0,
      openai_type: typeof openai,
      openai_exists: !!openai
    });
  }
});

// Fix existing files - connect all uploaded files to assistant (GET version for easy testing)
app.get('/connect-existing-files', async (req, res) => {
  try {
    if (!assistantId) {
      return res.status(400).json({ error: 'No assistant available' });
    }

    console.log('Starting file connection process...');
    console.log('Assistant ID:', assistantId);

    // Get all uploaded assistant files
    console.log('Fetching uploaded files...');
    const allFiles = await openai.files.list({ purpose: 'assistants' });
    console.log(`Found ${allFiles.data.length} uploaded files`);

    if (allFiles.data.length === 0) {
      return res.json({ message: 'No files to connect', file_count: 0 });
    }

    // Get file IDs
    const fileIds = allFiles.data.map(f => f.id);
    console.log('File IDs to connect:', fileIds.slice(0, 3), '...'); // Log first 3 for brevity

    // Try to create vector store with error handling
    console.log('Creating vector store...');
    let vectorStore;
    try {
      vectorStore = await openai.beta.vectorStores.create({
        name: `Course Materials ${new Date().toISOString().slice(0, 10)}`,
        file_ids: fileIds.slice(0, 10) // Limit to first 10 files to avoid issues
      });
      console.log('Vector store created successfully:', vectorStore.id);
    } catch (vectorError) {
      console.error('Vector store creation failed:', vectorError.message);
      
      // Try alternative approach - create empty vector store first
      try {
        console.log('Trying alternative approach...');
        vectorStore = await openai.beta.vectorStores.create({
          name: `Course Materials ${new Date().toISOString().slice(0, 10)}`
        });
        console.log('Empty vector store created:', vectorStore.id);
        
        // Add files one by one
        console.log('Adding files to vector store...');
        for (let i = 0; i < Math.min(fileIds.length, 5); i++) {
          try {
            await openai.beta.vectorStores.files.create(vectorStore.id, {
              file_id: fileIds[i]
            });
            console.log(`Added file ${i + 1}/${Math.min(fileIds.length, 5)}`);
          } catch (fileAddError) {
            console.error(`Failed to add file ${fileIds[i]}:`, fileAddError.message);
          }
        }
      } catch (altError) {
        console.error('Alternative approach failed:', altError.message);
        throw new Error('Could not create vector store: ' + altError.message);
      }
    }

    // Update assistant
    console.log('Updating assistant with vector store...');
    try {
      await openai.beta.assistants.update(assistantId, {
        tool_resources: {
          file_search: {
            vector_store_ids: [vectorStore.id]
          }
        }
      });
      console.log('Assistant updated successfully');
    } catch (updateError) {
      console.error('Assistant update failed:', updateError.message);
      throw new Error('Could not update assistant: ' + updateError.message);
    }

    // Success response
    res.json({
      success: true,
      message: `Successfully processed files`,
      vector_store_id: vectorStore.id,
      total_files: fileIds.length,
      processed_files: Math.min(fileIds.length, 10),
      assistant_id: assistantId
    });

  } catch (error) {
    console.error('Connection error:', error);
    res.status(500).json({ 
      error: 'Failed to connect files',
      details: error.message,
      stack: error.stack?.split('\n').slice(0, 3).join('\n') // First 3 lines of stack
    });
  }
});

const PORT = process.env.PORT || 3000;

// Initialize assistant and start server
async function startServer() {
  try {
    await createAssistant();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Assistant ID: ${assistantId}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
