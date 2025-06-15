const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

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
let assistantId = null;
let vectorStoreId = null;

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

IMPORTANT: You have access to course materials and documents that have been uploaded to your knowledge base. When users ask questions, always search through these materials first to provide course-specific guidance. Reference the uploaded documents when relevant, and base your advice on the frameworks and content from the course materials.

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

IMPORTANT: You have access to course materials and documents that have been uploaded to your knowledge base. When users ask questions, always search through these materials first to provide course-specific guidance. Reference the uploaded documents when relevant, and base your advice on the frameworks and content from the course materials.

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

// Chat endpoint
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

    // Get thread for this user
    const userId = req.ip || 'default';
    const threadId = await getOrCreateThread(userId);

    // Add user message to thread
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: message
    });

    // Create run with proper instructions
    let additionalInstructions = '';
    if (context && context.includes('structured question sequence')) {
      additionalInstructions = 'You are responding to an answer in a structured coaching sequence. Give a brief, encouraging response that acknowledges their answer and may reference previous responses for patterns, but do not ask follow-up questions. Search your attached files for relevant course material to inform your response.';
    } else if (context && context.includes('Current path:')) {
      additionalInstructions = `${context}. Always search through your attached course files and reference relevant content when applicable.`;
    } else {
      additionalInstructions = 'Search through your attached course files and reference relevant content from the uploaded materials when responding to the user\'s question. Use the file_search tool to find relevant information from the course materials.';
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

// Connect existing files endpoint - with better error handling
app.get('/connect-existing-files', async (req, res) => {
  try {
    console.log('=== Connect Existing Files Debug ===');
    console.log('OpenAI client exists:', !!openai);
    console.log('OpenAI beta exists:', !!openai?.beta);
    console.log('VectorStores exists:', !!openai?.beta?.vectorStores);
    console.log('Assistant ID:', assistantId);
    console.log('Vector Store ID:', vectorStoreId);

    // Ensure assistant exists
    if (!assistantId) {
      console.log('No assistant, creating one...');
      await createAssistant();
    }

    // Get all uploaded assistant files
    console.log('Fetching uploaded files...');
    const allFiles = await openai.files.list({ purpose: 'assistants' });
    console.log(`Found ${allFiles.data.length} uploaded files`);

    if (allFiles.data.length === 0) {
      return res.json({ 
        message: 'No files have been uploaded to OpenAI yet. Upload some files first.', 
        file_count: 0,
        debug: {
          assistant_id: assistantId,
          vector_store_id: vectorStoreId,
          has_vector_stores: !!openai?.beta?.vectorStores
        }
      });
    }

    // If no vector store (legacy mode), try to attach files directly to assistant
    if (!vectorStoreId) {
      console.log('No vector store, using legacy file attachment...');
      return await connectFilesLegacy(allFiles.data, res);
    }

    // Modern vector store approach
    console.log('Using vector store approach...');
    
    // Get files already in vector store to avoid duplicates
    const vectorStoreFiles = await openai.beta.vectorStores.files.list(vectorStoreId);
    const existingFileIds = new Set(vectorStoreFiles.data.map(f => f.id));

    // Filter out files already in vector store
    const filesToConnect = allFiles.data.filter(f => !existingFileIds.has(f.id));
    
    if (filesToConnect.length === 0) {
      return res.json({ 
        message: 'All files are already connected to the vector store', 
        file_count: existingFileIds.size,
        vector_store_id: vectorStoreId
      });
    }

    console.log(`Connecting ${filesToConnect.length} new files to vector store...`);

    // Connect each file to vector store
    const results = [];
    for (const file of filesToConnect) {
      try {
        await openai.beta.vectorStores.files.create(vectorStoreId, {
          file_id: file.id
        });
        results.push({ id: file.id, filename: file.filename, status: 'connected' });
        console.log(`✓ Connected file: ${file.filename}`);
      } catch (fileError) {
        console.error(`✗ Failed to connect file ${file.id}:`, fileError.message);
        results.push({ id: file.id, filename: file.filename, status: 'failed', error: fileError.message });
      }
    }

    const successCount = results.filter(r => r.status === 'connected').length;

    res.json({
      success: true,
      message: `Connected ${successCount} of ${filesToConnect.length} files to vector store`,
      connected_count: successCount,
      total_files_now: existingFileIds.size + successCount,
      vector_store_id: vectorStoreId,
      results: results
    });

  } catch (error) {
    console.error('=== Connection Error ===');
    console.error('Error type:', error.name);
    console.error('Error message:', error.message);
    console.error('Full error:', error);
    
    res.status(500).json({ 
      error: 'Failed to connect files',
      details: error.message,
      debug: {
        assistant_id: assistantId,
        vector_store_id: vectorStoreId,
        has_openai: !!openai,
        has_beta: !!openai?.beta,
        has_vector_stores: !!openai?.beta?.vectorStores,
        error_type: error.name
      }
    });
  }
});

// Legacy file connection for older API versions
async function connectFilesLegacy(files, res) {
  try {
    console.log('Attempting legacy file connection...');
    
    const fileIds = files.slice(0, 10).map(f => f.id); // Limit for legacy API
    
    // Try to update assistant with file_ids directly
    await openai.beta.assistants.update(assistantId, {
      file_ids: fileIds,
      tools: [{ type: "file_search" }]
    });
    
    console.log('Legacy file connection successful');
    
    return res.json({
      success: true,
      message: `Connected ${fileIds.length} files using legacy method`,
      connected_count: fileIds.length,
      method: 'legacy_file_ids',
      file_ids: fileIds
    });
    
  } catch (legacyError) {
    console.error('Legacy connection also failed:', legacyError.message);
    
    return res.status(500).json({
      error: 'Both modern and legacy file connection methods failed',
      details: legacyError.message,
      file_count: files.length
    });
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
      assistants_available: !!openai?.beta?.assistants
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

// Reset assistant endpoint - recreates assistant with proper file connections
app.get('/reset-assistant', async (req, res) => {
  try {
    console.log('=== RESETTING ASSISTANT ===');
    
    // Delete current assistant if it exists
    if (assistantId) {
      try {
        await openai.beta.assistants.del(assistantId);
        console.log('Deleted old assistant:', assistantId);
      } catch (deleteError) {
        console.log('Could not delete old assistant (might not exist):', deleteError.message);
      }
    }
    
    // Reset global variables
    assistantId = null;
    vectorStoreId = null;
    
    // Get all uploaded files
    const allFiles = await openai.files.list({ purpose: 'assistants' });
    console.log(`Found ${allFiles.data.length} uploaded files to attach`);
    
    if (allFiles.data.length === 0) {
      return res.json({
        success: true,
        message: 'Assistant reset, but no files to attach. Upload some files first.',
        assistant_id: null
      });
    }
    
    // Take first 20 files (OpenAI limit)
    const fileIds = allFiles.data.slice(0, 20).map(f => f.id);
    console.log(`Will attach ${fileIds.length} files to new assistant`);
    
    // Create new assistant with files attached directly
    const assistant = await openai.beta.assistants.create({
      name: "Entrepreneur Emotional Health Coach",
      instructions: `You are a virtual personal strategic advisor and coach for EntrepreneurEmotionalHealth.com. You guide high-achieving entrepreneurs through major growth areas: Identity & Calling, Personal Relationships, and Whole-Life Development.

You operate with deep psychological insight, system-level thinking, and a firm but compassionate tone. You help people break through self-sabotage, false identities, and emotional drift. You do not tolerate excuses, victim thinking, or surface-level quick fixes. You are direct, tough, strategic—and always rooting for their greatness.

IMPORTANT: You have access to course materials and documents that have been uploaded to your knowledge base. When users ask questions, always search through these materials first to provide course-specific guidance. Reference the uploaded documents when relevant, and base your advice on the frameworks and content from the course materials.

You are having a natural coaching conversation. Respond to what the person just said as you naturally would - with insight, challenges, follow-up questions, or observations. Be conversational, insightful, and responsive to their specific words and energy. Ask follow-up questions when appropriate. Challenge them when they need it. Celebrate breakthroughs when you sense them.

When users are in structured question sequences (Identity & Calling or Personal Relationships), acknowledge their answers naturally but avoid asking follow-up questions since the next question is predetermined. Keep responses brief and encouraging during these sequences, but draw connections between their current answer and previous responses when relevant.`,
      tools: [{ type: "file_search" }],
      file_ids: fileIds, // Direct file attachment
      model: "gpt-4o-mini",
    });
    
    assistantId = assistant.id;
    console.log('New assistant created successfully:', assistantId);
    console.log('Files attached:', assistant.file_ids?.length || 0);
    
    // Verify the files are attached
    const verifyAssistant = await openai.beta.assistants.retrieve(assistantId);
    
    res.json({
      success: true,
      message: `Assistant recreated successfully with ${verifyAssistant.file_ids?.length || 0} files attached`,
      assistant_id: assistantId,
      attached_files: verifyAssistant.file_ids?.length || 0,
      method: 'direct_file_ids'
    });
    
  } catch (error) {
    console.error('Reset assistant error:', error);
    res.status(500).json({
      error: 'Failed to reset assistant',
      details: error.message
    });
  }
});

// Simple OpenAI test endpoint
app.get('/test-openai', async (req, res) => {
  try {
    console.log('Testing OpenAI API...');
    
    // Test basic API access
    const models = await openai.models.list();
    console.log('✓ Models API working');
    
    // Test files API
    const files = await openai.files.list({ purpose: 'assistants' });
    console.log('✓ Files API working, found', files.data.length, 'files');
    
    // Test assistants API
    let assistantTest = 'not tested';
    if (openai.beta?.assistants) {
      try {
        if (assistantId) {
          await openai.beta.assistants.retrieve(assistantId);
          assistantTest = 'working';
        } else {
          assistantTest = 'no assistant created yet';
        }
      } catch (e) {
        assistantTest = 'failed: ' + e.message;
      }
    } else {
      assistantTest = 'beta API not available';
    }
    
    res.json({
      success: true,
      models_api: 'working',
      files_api: 'working',
      files_count: files.data.length,
      assistants_api: assistantTest,
      vector_stores_api: openai.beta?.vectorStores ? 'available' : 'not available',
      openai_version: 'unknown' // We can't easily get version from client
    });
    
  } catch (error) {
    res.status(500).json({
      error: 'OpenAI test failed',
      details: error.message,
      has_openai: !!openai,
      has_beta: !!openai?.beta
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

startServer();
