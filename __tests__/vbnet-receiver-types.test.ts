/**
 * A VB.NET call through a local, a parameter, a field or a property is a call
 * on the type it is declared with — `Dim x As T`, `ByVal x As T`,
 * `x As New T`, `Private File As SFile`, `Property File As SFile`, a type
 * character (`Dim name$`), or what `Dim x = obj.GetString(…)` returns —
 * never a guess at a same-named method of some project class. Keywords are
 * matched without regard to case. A declared type the project does not define
 * means nothing of the project's, except an extension method declared for it.
 *
 * - SCrawler's `ThumbnailFile.Delete(SFO.File, …)` on an `SFile` (from the
 *   external PersonalUtilities library) went to a nested `TempFileConversion`
 *   class's `Delete`, `GroupFile.Delete()` to a download group's,
 *   `UserUpdatedEventHandlers.Add(e)` on a `List(Of …)` to `UserDataBind.Add`
 *   and `TotalSize.CompareTo(…)` on a `Double` to a plugin's `VSize.CompareTo`;
 * - staxrip's `timestampFontColorValue.ToColor(…)`, a String from
 *   `settings.GetString(…)`, went to a `ColorHSL.ToColor()` instead of the
 *   String extension `StringExtensions.ToColor`.
 *
 * The type a name means is the one VB.NET's lookup finds where it is written:
 * the namespaces around it (SCrawler declares a `SiteSettings` and an `M3U8`
 * per site namespace), a base class's nested types, the file's `Imports`
 * aliases, and the type arguments a subclass gives its base. The declared
 * type wins over whatever is assigned later, a `For Each` variable is an
 * element of what it loops over, and an interface a class implements lends
 * it no members to read bare.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vb-receiver-'));
  const files: Record<string, string> = {
    'Download/Groups/DownloadGroup.vb': `Namespace DownloadObjects.Groups
    Friend Class DownloadGroup
        Friend Sub Delete()
        End Sub
    End Class
End Namespace
`,
    'YouTube/Objects/YouTubeMediaContainerBase.vb': `Namespace API.YouTube.Objects
    Public MustInherit Class YouTubeMediaContainerBase
        Public ReadOnly Property ThumbnailFile As SFile
        Private Class TempFileConversion
            Friend Sub Delete(ByVal Mode As Integer)
            End Sub
        End Class
    End Class
End Namespace
`,
    'Download/Groups/DownloadGroupCollection.vb': `Namespace DownloadObjects.Groups
    Friend Class DownloadGroupCollection
        Private ReadOnly GroupFile As SFile = "Settings\\Groups.xml"
        Friend Sub Update()
            GroupFile.Delete()
        End Sub
        Friend Sub Reset(byval groupFile as SFile)
            groupFile.Delete()
        End Sub
    End Class
End Namespace
`,
    'Hosts/DownloadableMediaHost.vb': `Namespace Hosts
    Friend Class DownloadableMediaHost : Inherits API.YouTube.Objects.YouTubeMediaContainerBase
        Friend Sub Clean()
            ThumbnailFile.Delete(1)
        End Sub
    End Class
End Namespace
`,
    'API/UserDataBind.vb': `Namespace API
    Friend Class UserDataBind
        Friend Sub Add(ByVal User As Object)
        End Sub
    End Class
End Namespace
`,
    'API/Base/UserDataBase.vb': `Namespace API.Base
    Friend MustInherit Class UserDataBase
        Private ReadOnly UserUpdatedEventHandlers As List(Of UserUpdatedEventHandler)
        Friend Sub AddUpdateHandler(ByVal e As UserUpdatedEventHandler)
            UserUpdatedEventHandlers.Add(e)
        End Sub
        Friend Sub Download()
        End Sub
    End Class
End Namespace
`,
    'API/Instagram/UserData.vb': `Namespace API.Instagram
    Friend Class UserData : Inherits API.Base.UserDataBase
    End Class
End Namespace
`,
    'API/Instagram/Downloader.vb': `Namespace API.Instagram
    Friend Class Downloader
        Friend Sub Run(ByVal u As UserData)
            u.Download()
        End Sub
    End Class
End Namespace
`,
    'Plugin/UserData.vb': `Friend Class VSize
    Public Function CompareTo(ByVal Other As VSize) As Integer
        Return 0
    End Function
End Class
`,
    'Editors/UsersInfoForm.vb': `Friend Class UsersInfoForm
    Private NotInheritable Class UserOpt
        Friend Property TotalSize As Double = 0
        Friend Function CompareTo(ByVal Other As UserOpt) As Integer
            Return TotalSize.CompareTo(Other.TotalSize) * -1
        End Function
    End Class
End Class
`,
    'UI/ColorHSL.vb': `Public Class ColorHSL
    Public Sub New(ByVal h As Double, ByVal s As Double, ByVal l As Double, ByVal a As Double)
    End Sub
    Public Function AddLuminance(ByVal offset As Single) As ColorHSL
        Return Me
    End Function
    Public Function ToColor() As Integer
        Return 0
    End Function
End Class
`,
    'UI/BackColorAdjuster.vb': `Public Class BackColorAdjuster
    Public Function AddLuminance(ByVal offset As Single) As Integer
        Return 0
    End Function
End Class
`,
    'UI/ThemeManager.vb': `Public Class ThemeManager
    Public Sub Apply()
        Dim _backColor As ColorHSL = New ColorHSL(0, 0.01, 0.1, 1)
        Dim _controlBackColor As ColorHSL = _backColor.AddLuminance(0.025)
    End Sub
End Class
`,
    'UI/Popup.vb': `Public Class Popup
    Public Sub Show()
    End Sub
End Class
`,
    'UI/MainForm.vb': `Public Class MainForm
    Inherits Form

    Public Sub OpenSettings()
        Dim settingsForm As New MainForm
        settingsForm.Show()
    End Sub
End Class
`,
    'General/Extensions.vb': `Imports System.Runtime.CompilerServices

Module StringExtensions
    <Extension>
    Function ToColor(ByVal str As String, Optional ByVal defaultColor As Integer = 0) As Integer
        Return 0
    End Function
    <Extension>
    Function Join(ByVal instance As IEnumerable(Of String), ByVal delimiter As String) As String
        Return ""
    End Function
    <Extension>
    Function Sort(Of T)(ByVal instance As IEnumerable(Of T)) As IEnumerable(Of T)
        Return instance
    End Function
End Module
`,
    'General/ObjectStorage.vb': `Public Class ObjectStorage
    Public Function GetString(ByVal key As String, Optional ByVal defaultValue As String = Nothing) As String
        Return defaultValue
    End Function
End Class
`,
    'General/Thumbnailer.vb': `Public Class Thumbnailer
    Public Sub Run(ByVal settings As ObjectStorage)
        Dim timestampFontColorValue = settings.GetString("TimestampFontColor", "#fff")
        Dim timestampFontColor = timestampFontColorValue.ToColor(1)
        Dim colorText As String = "#000"
        Dim outline = colorText.ToColor()
        Dim name$ = "x"
        Dim named = name.ToColor()
    End Sub
End Class
`,
    'General/Lists.vb': `Public Class Lists
    Public Sub Run()
        Dim names As New List(Of String)
        names.Sort()
        Dim joined = names.Join(", ")
    End Sub
End Class
`,
    'Base/DownDetector.vb': `Namespace API.Base
    Friend NotInheritable Class DownDetector
        Friend MustInherit Class Checker(Of T)
            Protected ReadOnly Property Source As T
        End Class
    End Class
End Namespace
`,
    'Sites/Bluesky/SiteSettings.vb': `Namespace API.Bluesky
    Friend Class SiteSettings
        Friend Function IsMyUser(ByVal url As String) As Boolean
            Return False
        End Function
        Friend Function AvailableTrueValue() As Boolean
            Return False
        End Function
    End Class
    Friend NotInheritable Class M3U8
        Friend Shared Sub Download(ByVal url As String)
        End Sub
    End Class
End Namespace
`,
    'Sites/Reddit/SiteSettings.vb': `Namespace API.Reddit
    Friend Class SiteSettings
        Friend Function IsMyUser(ByVal url As String) As Boolean
            Return True
        End Function
        Friend Function AvailableTrueValue() As Boolean
            Return True
        End Function
        Private Class MyDownDetector : Inherits API.Base.DownDetector.Checker(Of SiteSettings)
            Friend Sub Check()
                Source.AvailableTrueValue()
            End Sub
        End Class
    End Class
    Friend NotInheritable Class M3U8
        Friend Shared Sub Download(ByVal url As String)
        End Sub
    End Class
End Namespace
`,
    'Sites/Reddit/UserData.vb': `Namespace API.Reddit
    Friend Class UserData
        Private ReadOnly Property MySettings As SiteSettings
        Friend Sub Check(ByVal url As String)
            MySettings.IsMyUser(url)
            M3U8.Download(url)
        End Sub
    End Class
End Namespace
`,
    'Encoding/VideoEncoder.vb': `Public MustInherit Class VideoEncoder
    Public Class MenuList
        Public Sub Add(ByVal text As String)
        End Sub
    End Class
End Class
Public Class BatchEncoder
    Inherits VideoEncoder
    Public Function GetMenu() As Object
        Dim ret As New MenuList
        ret.Add("Codec Configuration")
        Return ret
    End Function
End Class
`,
    'YouTube/YouTubeFunctions.vb': `Friend Interface IContainer
    Sub Parse()
End Interface
Friend Class Channel : Implements IContainer
    Friend Sub Parse() Implements IContainer.Parse
    End Sub
End Class
Friend Module YouTubeFunctions
    Friend Sub Load()
        Dim item As IContainer
        item = New Channel
        item.Parse()
    End Sub
End Module
`,
    'UI/Labels.vb': `Public Class LabelUI
    Public Function AddLabel(ByVal text As String) As Object
        Return Nothing
    End Function
End Class
Public Class SimpleUI
    Public Function AddLabel(ByVal text As String) As Object
        Return Nothing
    End Function
    Public Function AddLabel(ByVal text As String, ByVal width As Integer) As Object
        Return Nothing
    End Function
End Class
Public Class SimpleSettingsForm
    Friend WithEvents SimpleUI As SimpleUI
End Class
`,
    'UI/AudioForm.vb': `Public Class AudioForm
    Public Sub ShowAdvanced()
        Using form As New SimpleSettingsForm()
            Dim ui = form.SimpleUI
            ui.AddLabel("EBU R128")
        End Using
    End Sub
End Class
`,
    'UI/Theme.vb': `Public Class ButtonLabel
    Public Sub ApplyTheme()
    End Sub
End Class
Public Class ToggleButtonLabel
    Public Sub ApplyTheme()
    End Sub
End Class
Public Class ThemeApplier
    Public Sub Apply(ByVal controls As Object)
        For Each control In controls.OfType(Of ToggleButtonLabel)
            control.ApplyTheme()
        Next
    End Sub
    Public Sub ApplyAll(ByVal labels As List(Of ToggleButtonLabel))
        For Each label In labels
            label.ApplyTheme()
        Next
    End Sub
End Class
`,
    'Download/TDownloader.vb': `Namespace App.Download
    Friend Class TDownloader
        Friend Class Job
            Friend Sub Start()
            End Sub
        End Class
    End Class
    Friend Class Worker
        Friend Sub Start()
        End Sub
    End Class
End Namespace
`,
    'Download/DownloadProgress.vb': `Imports TDJob = App.Download.TDownloader.Job

Namespace App.Download
    Friend Class DownloadProgress
        Friend ReadOnly Property Worker As TDJob
        Friend Sub Run()
            Worker.Start()
        End Sub
    End Class
End Namespace
`,
    'Plugin/IPluginContentProvider.vb': `Namespace Plugin
    Public Interface ISiteSettings
    End Interface
    Public Interface IPluginContentProvider
        Property Settings As ISiteSettings
    End Interface
End Namespace
`,
    'MainMod.vb': `Friend Module MainMod
    Friend Settings As SettingsCLS
End Module
`,
    'SettingsCLS.vb': `Friend Class SettingsCLS
    Friend Sub UpdateUsersList()
    End Sub
End Class
`,
    'API/Base/UserDataProvider.vb': `Namespace API.Base
    Friend MustInherit Class UserDataProvider : Implements Plugin.IPluginContentProvider
        Friend Property MySettings As Plugin.ISiteSettings Implements Plugin.IPluginContentProvider.Settings
        Friend Sub Delete()
            Settings.UpdateUsersList()
        End Sub
    End Class
End Namespace
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `Owner::member` of every call edge out of a file. */
function callsFrom(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('VB.NET calls through declared receivers', () => {
  it('reach nothing of the project on a type it does not define', () => {
    expect(callsFrom('Download/Groups/DownloadGroupCollection.vb')).toEqual([]);
    expect(callsFrom('Hosts/DownloadableMediaHost.vb')).toEqual([]);
    expect(callsFrom('API/Base/UserDataBase.vb')).toEqual([]);
  });

  it('reach nothing of the project on a VB.NET built-in type', () => {
    expect(callsFrom('Editors/UsersInfoForm.vb')).toEqual([]);
  });

  it('reach the declared type’s own method, or the one it inherits', () => {
    expect(callsFrom('UI/ThemeManager.vb')).toEqual(['ColorHSL::AddLuminance']);
    expect(callsFrom('API/Instagram/Downloader.vb')).toEqual(['API.Base::UserDataBase::Download']);
  });

  it('reach nothing of the project for a method the declared type inherits from outside it', () => {
    expect(callsFrom('UI/MainForm.vb')).toEqual([]);
  });

  it('reach an extension method declared for the type, through what a call returns too', () => {
    expect(callsFrom('General/Thumbnailer.vb')).toEqual([
      'ObjectStorage::GetString',
      'StringExtensions::ToColor',
      'StringExtensions::ToColor',
      'StringExtensions::ToColor',
    ]);
  });

  it('reach a .NET type’s own method before an extension of that name, and an extension it lacks', () => {
    // `List(Of T)` has its own `Sort()`, but no `Join`.
    expect(callsFrom('General/Lists.vb')).toEqual(['StringExtensions::Join']);
  });

  it('name the type their declaration’s namespace sees, through a base class’s type argument too', () => {
    // SCrawler declares a `SiteSettings` and an `M3U8` in each site's namespace.
    expect(callsFrom('Sites/Reddit/UserData.vb')).toEqual([
      'API.Reddit::M3U8::Download',
      'API.Reddit::SiteSettings::IsMyUser',
    ]);
    // `Inherits DownDetector.Checker(Of SiteSettings)` makes its `Source As T` a SiteSettings.
    expect(callsFrom('Sites/Reddit/SiteSettings.vb')).toEqual(['API.Reddit::SiteSettings::AvailableTrueValue']);
    // A type nested in a base class is named bare in a subclass: staxrip's `Dim ret As New MenuList`.
    expect(callsFrom('Encoding/VideoEncoder.vb')).toEqual(['VideoEncoder::MenuList::Add']);
  });

  it('take the declared type over what is assigned, and an import alias for what it names', () => {
    expect(callsFrom('YouTube/YouTubeFunctions.vb')).toEqual(['IContainer::Parse']);
    expect(callsFrom('Download/DownloadProgress.vb')).toEqual(['App.Download::TDownloader::Job::Start']);
  });

  it('read a field through what a call returns, and a loop variable through what it loops over', () => {
    expect(callsFrom('UI/AudioForm.vb')).toEqual(['SimpleUI::AddLabel']);
    // `For Each control In controls.OfType(Of ToggleButtonLabel)`, `For Each label In labels` over a `List(Of ToggleButtonLabel)`.
    expect(callsFrom('UI/Theme.vb')).toEqual(['ToggleButtonLabel::ApplyTheme', 'ToggleButtonLabel::ApplyTheme']);
  });

  it('see a module’s field, not the property of an interface the class implements', () => {
    expect(callsFrom('API/Base/UserDataProvider.vb')).toEqual(['SettingsCLS::UpdateUsersList']);
  });
});
