// SP3D adapter for PipeRunNaming. NOT COMPILED OR TESTED against SP3D.
//
// Confirmed from the delivered PipingNameRules.dll (namespace
// Ingr.SP3D.Content.Piping.Rules):
//   - base class   Ingr.SP3D.Common.Middle.NameRuleBase   (CommonMiddle.dll)
//   - overrides    Collection<BusinessObject> GetNamingParents(BusinessObject)
//                  void ComputeName(BusinessObject, ReadOnlyCollection<BusinessObject>, BusinessObject)
//
// NOT confirmed (the delivered DLL only shows these names exist, not how they
// are called on a pipe run): the lines marked VERIFY below. The compiler will
// flag any that are wrong; fix them against the delivered rules or the SP3D
// Programmer's Guide.

using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using Ingr.SP3D.Common.Middle;

namespace Protofile.Sp3d
{
    public class PipeRunNameRule : NameRuleBase
    {
        // Diagnostic log: proves whether SP3D loads and calls this rule.
        // Look for it in the Windows temp folder of the user running SP3D.
        private static void Log(string message)
        {
            try
            {
                File.AppendAllText(
                    Path.Combine(Path.GetTempPath(), "PipeRunNameRule.log"),
                    DateTime.Now.ToString("s") + " " + message + Environment.NewLine);
            }
            catch { /* logging must never break naming */ }
        }

        // The pipeline is the naming parent, so the name is recomputed
        // when the run is moved to another pipeline.
        public override Collection<BusinessObject> GetNamingParents(BusinessObject oEntity)
        {
            Log("GetNamingParents called");
            var parents = new Collection<BusinessObject>();
            // VERIFY: how to get the parent pipeline (system) of a pipe run.
            ISystemChild child = oEntity as ISystemChild;
            if (child != null && child.SystemParent != null)
                parents.Add((BusinessObject)child.SystemParent);
            return parents;
        }

        public override void ComputeName(
            BusinessObject oEntity,
            ReadOnlyCollection<BusinessObject> oParents,
            BusinessObject oActiveEntity)
        {
            Log("ComputeName called, parents=" + (oParents == null ? "null" : oParents.Count.ToString()));
            try
            {
                ComputeNameCore(oEntity, oParents);
            }
            catch (Exception ex)
            {
                Log("ComputeName FAILED: " + ex);
                throw;
            }
        }

        private void ComputeNameCore(BusinessObject oEntity, ReadOnlyCollection<BusinessObject> oParents)
        {
            if (oEntity == null) throw new ArgumentNullException("oEntity");
            if (oParents == null || oParents.Count == 0) return; // no pipeline yet: keep current name

            // VERIFY: INamedItem.Name for the pipeline's name.
            string pipelineName = ((INamedItem)oParents[0]).Name;

            // Names of the runs already under this pipeline (needed so numbers are not reused).
            var existing = new List<string>();
            // VERIFY: children of a pipeline system.
            ISystem pipeline = oParents[0] as ISystem;
            if (pipeline != null)
            {
                foreach (BusinessObject sibling in pipeline.SystemChildren)
                {
                    if (sibling.ObjectID == oEntity.ObjectID) continue; // not the run being named
                    INamedItem named = sibling as INamedItem;
                    if (named != null) existing.Add(named.Name);
                }
            }

            string name = PipeRunNaming.Build(pipelineName, existing);

            // VERIFY: the delivered rules write the name with SetPropertyValue.
            oEntity.SetPropertyValue(name, "IJNamedItem", "Name");
            Log("Named '" + name + "'");
        }
    }
}
