#define MyAppName "MultiAudio Nouva"
#define MyAppPublisher "Quorraa"

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

#ifndef SourceDir
  #define SourceDir "..\dist\portable\win-x64\app"
#endif

#ifndef OutputDir
  #define OutputDir "..\dist\installer"
#endif

[Setup]
AppId={{7B1D35B0-ED0C-4F86-A225-14857E9F8D31}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
OutputDir={#OutputDir}
OutputBaseFilename=MultiAudioNouva-{#AppVersion}-setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\MultiAudioNouva.exe

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\MultiAudioNouva.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\MultiAudioNouva.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\MultiAudioNouva.exe"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent
