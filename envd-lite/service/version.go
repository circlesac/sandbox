package service

// Version is the upstream envd API level envd-lite implements. The control
// plane reports it to the SDK, which gates features on it (for example,
// octet-stream uploads from 0.5.7 and file metadata from 0.6.2).
const Version = "0.5.3"
